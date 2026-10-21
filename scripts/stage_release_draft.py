#!/usr/bin/env python3
"""Fail-closed, identity-bound GitHub draft staging (R6).

Only GitHub REST GET and one CREATE POST plus one upload POST per asset.
No retries, redirects, tag writes, draft reuse, deletion or publication.
Python 3.11+ standard library only. A failed/ambiguous mutation is manual review.
"""
from __future__ import annotations

from dataclasses import dataclass
from contextlib import contextmanager
import hashlib
import http.client
import json
import os
from pathlib import Path
import re
import signal
import threading
import ssl
import stat
import sys
import tempfile
import time
from urllib.parse import quote, urlsplit, parse_qs

API = 'https://api.github.com'
UPLOADS = 'https://uploads.github.com'
SHA = re.compile(r'[0-9a-fA-F]{40}\Z')
SAFE = re.compile(r'[A-Za-z0-9][A-Za-z0-9._+-]*\Z')
MAX_ID = 2**63 - 1


class StageError(Exception):
    def __init__(self, message: str, exit_code: int = 3):
        super().__init__(message)
        self.exit_code = exit_code


def need(ok: bool, message: str, code: int = 3) -> None:
    if not ok:
        raise StageError(message, code)


def strict_json(data: bytes):
    def pairs(items):
        result, folded = {}, set()
        for key, value in items:
            name = key.casefold()
            if name in folded:
                raise ValueError('duplicate or case-variant JSON key')
            folded.add(name)
            result[key] = value
        return result

    def constants(value):
        raise ValueError('non-finite JSON number')

    try:
        # json.loads consumes the entire document, rejects NUL/trailing data and UTF-8 errors.
        result = json.loads(data.decode('utf-8'), object_pairs_hook=pairs,
                            parse_constant=constants)
    except (UnicodeError, ValueError, TypeError, RecursionError) as exc:
        raise StageError('Invalid complete REST JSON document') from exc
    return result


def obj(value, fields=()):
    need(type(value) is dict and all(field in value for field in fields),
         'Missing mandatory REST object fields')
    return value


def pos_int(value):
    need(type(value) is int and 0 < value <= MAX_ID, 'Invalid immutable numeric ID')
    return value


def sha(value):
    need(type(value) is str and SHA.fullmatch(value) is not None, 'Invalid commit SHA')
    return value.lower()


def env_int(name, default, minimum, maximum):
    raw = os.environ.get(name, str(default))
    need(re.fullmatch(r'[1-9][0-9]*', raw) is not None,
         f'Invalid configured limit {name}')
    number = int(raw)
    need(minimum <= number <= maximum, f'Configured limit outside supported range {name}')
    return number


@contextmanager
def deadline_guard(seconds):
    # The publishing job runs on Linux. A socket idle timeout alone cannot
    # bound a slow-trickling read because each read may continually make progress.
    # SIGALRM independently stops the entire HTTP request at a hard wall clock.
    need(hasattr(signal, 'setitimer') and threading.current_thread() is threading.main_thread(),
         'Hard HTTP deadline unavailable on this runner')
    previous = signal.getsignal(signal.SIGALRM)
    previous_timer = signal.getitimer(signal.ITIMER_REAL)
    begun = time.monotonic()
    def expired(*_):
        raise StageError('HTTP hard wall-clock timeout')
    signal.signal(signal.SIGALRM, expired)
    signal.setitimer(signal.ITIMER_REAL, max(.001, seconds))
    try:
        yield
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous)
        if previous_timer[0] > 0:
            remainder = previous_timer[0] - (time.monotonic() - begun)
            signal.setitimer(signal.ITIMER_REAL, max(.001, remainder), previous_timer[1])


@dataclass(frozen=True)
class Limits:
    pages: int
    body: int
    total: int
    request_timeout: int
    preflight_seconds: int
    overall_seconds: int
    upload_seconds: int

    @classmethod
    def from_env(cls):
        return cls(env_int('RELEASE_MAX_PAGES', 32, 1, 256),
                   env_int('RELEASE_MAX_RESPONSE_BYTES', 8 * 1024 * 1024, 1024, 32 * 1024 * 1024),
                   env_int('RELEASE_MAX_TOTAL_BYTES', 32 * 1024 * 1024, 1024, 256 * 1024 * 1024),
                   env_int('RELEASE_REQUEST_TIMEOUT', 15, 1, 120),
                   env_int('RELEASE_PREFLIGHT_SECONDS', 180, 1, 1200),
                   env_int('RELEASE_OVERALL_SECONDS', 3600, 1, 21600),
                   env_int('RELEASE_UPLOAD_TIMEOUT', 1800, 1, 21600))


@dataclass(frozen=True)
class Response:
    status: int
    headers: tuple[tuple[str, str], ...]
    body: bytes

    def header(self, name):
        matches = [value for key, value in self.headers if key.lower() == name.lower()]
        need(len(matches) <= 1, f'Ambiguous HTTP header {name}')
        return matches[0] if matches else None


class Rest:
    def __init__(self, token, limits):
        self.token = token
        self.limits = limits
        self.downloaded = 0
        self.start = time.monotonic()
        self.preflight_deadline = self.start + limits.preflight_seconds
        self.deadline = self.start + limits.overall_seconds

    def request(self, method, url, *, payload=None, file_path=None, size=None, expected_digest=None,
                preflight=False):
        parsed = urlsplit(url)
        need(parsed.scheme == 'https' and parsed.hostname in ('api.github.com', 'uploads.github.com')
             and parsed.port is None and parsed.username is None and parsed.password is None
             and parsed.fragment == '' and parsed.path.startswith('/repos/'),
             'Untrusted REST destination')
        need(parsed.hostname == ('uploads.github.com' if file_path is not None else 'api.github.com'),
             'REST operation directed to wrong host')
        need(method in ('GET', 'POST'), 'Unsupported HTTP mutation')
        if method == 'GET':
            need(file_path is None and payload is None, 'Malformed GET')
        if method == 'POST':
            need((file_path is None) != (payload is None), 'Ambiguous POST body')
        now = time.monotonic()
        limit = min(self.deadline, self.preflight_deadline) if preflight else self.deadline
        need(now < limit, 'REST operation time budget exhausted')
        timeout = max(.01, min(self.limits.request_timeout, limit - now))
        conn = http.client.HTTPSConnection(parsed.hostname, 443, timeout=timeout,
                                         context=ssl.create_default_context())
        path = parsed.path + (('?' + parsed.query) if parsed.query else '')
        hard_timeout = (self.limits.upload_seconds if file_path is not None
                        else self.limits.request_timeout)
        with deadline_guard(min(limit - now, hard_timeout)):
            try:
                conn.putrequest(method, path, skip_accept_encoding=True)
                conn.putheader('Authorization', 'Bearer ' + self.token)
                conn.putheader('Accept', 'application/vnd.github+json')
                conn.putheader('X-GitHub-Api-Version', '2022-11-28')
                conn.putheader('User-Agent', 'gpt-web-codex-release-stage/2.3.0')
                if payload is not None:
                    body = json.dumps(payload, separators=(',', ':'), ensure_ascii=True).encode('ascii')
                    conn.putheader('Content-Type', 'application/json')
                    conn.putheader('Content-Length', str(len(body)))
                if file_path is not None:
                    need(type(size) is int and size >= 0, 'Invalid upload length')
                    conn.putheader('Content-Type', 'application/octet-stream')
                    conn.putheader('Content-Length', str(size))
                conn.endheaders()
                if payload is not None:
                    conn.send(body)
                if file_path is not None:
                    with open_safe(file_path) as stream:
                        need(stream.stat_size == size, 'Upload input size changed')
                        sent = 0
                        uploaded_hash = hashlib.sha256()
                        while True:
                            need(time.monotonic() < self.deadline, 'Upload time budget exhausted')
                            chunk = stream.read(1024 * 1024)
                            if not chunk:
                                break
                            sent += len(chunk)
                            need(sent <= size, 'Upload content size changed')
                            uploaded_hash.update(chunk)
                            conn.send(chunk)
                        need(expected_digest == uploaded_hash.hexdigest(),
                             'Upload bytes changed since local SHA-256 inspection')
                        need(sent == size and stream.unchanged(), 'Upload input changed in transit')
                response = conn.getresponse()
                headers = tuple(response.getheaders())
                wire = Response(response.status, headers, b'')
                mime = wire.header('Content-Type')
                length = wire.header('Content-Length')
                transfer = wire.header('Transfer-Encoding')
                location = wire.header('Location')
                encoding = wire.header('Content-Encoding')
                need(encoding is None and not 300 <= response.status < 400,
                     'Redirect or content encoding disallowed')
                if location is not None:
                    dest = urlsplit(location)
                    need(response.status == 201 and dest.scheme == 'https'
                         and dest.hostname == 'api.github.com' and dest.port is None
                         and dest.username is None and dest.fragment == ''
                         and dest.path.startswith(parsed.path.split('/assets', 1)[0].split('?')[0]),
                         'Unexpected 201 Location header')
                need(mime is not None and re.fullmatch(r'application/(?:[a-z0-9.-]+\+)?json(?:\s*;[^\r\n]*)?',
                                                        mime.lower()) is not None,
                     'Missing or incompatible JSON Content-Type')
                need((length is None) != (transfer is None), 'Ambiguous HTTP framing')
                if transfer is not None:
                    need(transfer.lower() == 'chunked', 'Unknown transfer encoding')
                if length is not None:
                    need(re.fullmatch(r'(?:0|[1-9][0-9]*)', length) is not None,
                         'Invalid Content-Length')
                    need(int(length) <= self.limits.body and
                         self.downloaded + int(length) <= self.limits.total,
                         'HTTP response exceeds budget before download')
                chunks, used = [], 0
                while True:
                    need(time.monotonic() < limit, 'HTTP read time budget exhausted')
                    allowance = min(self.limits.body - used, self.limits.total - self.downloaded - used)
                    need(allowance >= 0, 'HTTP response budget exhausted')
                    # Reading at most allowance+1 detects oversize *during* reception.
                    data = response.read(min(65536, allowance + 1))
                    if not data:
                        break
                    used += len(data)
                    need(used <= self.limits.body and self.downloaded + used <= self.limits.total,
                         'HTTP response byte budget exhausted')
                    chunks.append(data)
                if length is not None:
                    need(used == int(length) and response.length == 0,
                         'Truncated HTTP response')
                self.downloaded += used
                need(0 < used and 100 <= response.status <= 599, 'Empty or invalid HTTP response')
                need(time.monotonic() <= limit, 'HTTP operation exceeded time budget')
                return Response(response.status, headers, b''.join(chunks))
            except (OSError, ssl.SSLError, http.client.HTTPException, TimeoutError, ValueError) as exc:
                raise StageError('HTTP transport/framing failed: ' + type(exc).__name__) from exc
            finally:
                conn.close()


class SafeFile:
    def __init__(self, path):
        self.path = Path(path)
        self.fd = None

    def __enter__(self):
        self.fd = os.open(self.path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0))
        self.before = os.fstat(self.fd)
        need(stat.S_ISREG(self.before.st_mode), 'Release asset must be regular')
        self.stat_size = self.before.st_size
        return self

    def read(self, count):
        return os.read(self.fd, count)

    def unchanged(self):
        after = os.fstat(self.fd)
        disk = os.stat(self.path, follow_symlinks=False)
        return all(getattr(item, attr) == getattr(self.before, attr)
                   for item in (after, disk) for attr in ('st_dev', 'st_ino', 'st_size', 'st_mtime_ns', 'st_ctime_ns'))

    def __exit__(self, *_):
        if self.fd is not None:
            os.close(self.fd)


def open_safe(path):
    return SafeFile(path)


def local_assets(directory):
    need(directory.is_dir() and not directory.is_symlink(), 'Missing valid release directory', 2)
    paths = sorted(directory.iterdir(), key=lambda p: p.name)
    need(len(paths) >= 2 and any(p.name == 'checksums.txt' for p in paths),
         'Missing assets or checksums.txt', 2)
    for path in paths:
        name = path.name
        need(SAFE.fullmatch(name) is not None and not name.endswith('.') and len(name) <= 255
             and path.is_file() and not path.is_symlink(), 'Unsafe release asset', 2)
    manifest = directory / 'checksums.txt'
    with open_safe(manifest) as stream:
        need(stream.stat_size <= 1024 * 1024, 'Oversized checksum manifest', 2)
        raw = stream.read(1024 * 1024 + 1)
        need(stream.unchanged(), 'Checksum manifest changed', 2)
    try:
        lines = raw.decode('ascii').splitlines(keepends=True)
    except UnicodeError as exc:
        raise StageError('Invalid checksum manifest', 2) from exc
    checks = {}
    for line in lines:
        match = re.fullmatch(r'([0-9a-fA-F]{64})  ([A-Za-z0-9][A-Za-z0-9._+-]*)\n', line)
        need(match is not None, 'Invalid checksum manifest entry', 2)
        digest, name = match.groups()
        need(name not in checks and name != 'checksums.txt' and not name.endswith('.'),
             'Invalid or repeated checksummed filename', 2)
        checks[name] = digest.lower()
    names = {p.name for p in paths if p.name != 'checksums.txt'}
    need(set(checks) == names, 'Checksum manifest does not exactly describe local release assets', 2)
    result = {}
    for path in paths:
        h = hashlib.sha256()
        with open_safe(path) as stream:
            size = stream.stat_size
            while True:
                chunk = stream.read(1024 * 1024)
                if not chunk:
                    break
                h.update(chunk)
            need(stream.unchanged(), 'Release asset mutated during hashing', 2)
        digest = h.hexdigest()
        need(path.name == 'checksums.txt' or checks[path.name] == digest,
             'Checksum verification failed', 2)
        result[path.name] = (path, size, digest)
    return result


def check_link(response, page, per_page, *, expected_path):
    link = response.header('Link')
    if link is None:
        return False
    next_links = []
    for part in link.split(','):
        match = re.fullmatch(r'\s*<([^<>]+)>\s*;\s*rel="?([a-z]+)"?\s*', part)
        need(match is not None, 'Malformed pagination Link metadata')
        if match.group(2) == 'next':
            next_links.append(match.group(1))
    need(len(next_links) <= 1, 'Ambiguous pagination Link metadata')
    if next_links:
        url = urlsplit(next_links[0])
        query = parse_qs(url.query)
        need(url.scheme == 'https' and url.hostname == 'api.github.com'
             and url.port is None and url.username is None and url.fragment == ''
             and (url.path == expected_path or
                  re.fullmatch(r'/repositories/[1-9][0-9]*/releases' +
                               re.escape(expected_path.split('/releases', 1)[1]), url.path))
             and query.get('page') == [str(page + 1)]
             and query.get('per_page') == [str(per_page)],
             'Non-consecutive pagination Link')
    return bool(next_links)


def release_entry(entry, target):
    obj(entry, ('id', 'tag_name', 'name', 'draft', 'prerelease'))
    rid = pos_int(entry['id'])
    tag, name = entry['tag_name'], entry['name']
    need(type(tag) is str and bool(tag) and
         (name is None or type(name) is str) and
         type(entry['draft']) is bool and type(entry['prerelease']) is bool,
         'Malformed release-list schema')
    need(tag.casefold() != target.casefold() and
         (name is None or name.casefold() != target.casefold()),
         'Existing release or title collision; refusing create')
    return rid, tag


def list_absence(rest, stem, target, max_pages):
    ids, tags = set(), set()
    # Always request the explicit next consecutive page; never trust Link as a pager.
    for page in range(1, max_pages + 1):
        response = rest.request('GET', f'{API}{stem}?per_page=100&page={page}', preflight=True)
        need(response.status == 200, 'Release listing did not return HTTP 200')
        linked_next = check_link(response, page, 100, expected_path=stem)
        entries = strict_json(response.body)
        need(type(entries) is list and len(entries) <= 100, 'Invalid release listing page')
        for entry in entries:
            rid, tag = release_entry(entry, target)
            need(rid not in ids and tag not in tags, 'Duplicate release ID or tag')
            ids.add(rid); tags.add(tag)
        if len(entries) == 0:
            need(not linked_next, 'Empty release page advertises more pages')
            return ids
        if len(entries) < 100:
            need(page < max_pages, 'No budget for pagination boundary')
            boundary = rest.request('GET', f'{API}{stem}?per_page=100&page={page+1}', preflight=True)
            need(boundary.status == 200, 'Pagination boundary HTTP failure')
            need(not check_link(boundary, page + 1, 100, expected_path=stem),
                 'Empty pagination boundary advertises further pages')
            need(strict_json(boundary.body) == [], 'Nonempty or invalid pagination boundary')
            return ids
    raise StageError('Release page budget exhausted without verified boundary')


def list_release_assets(rest, stem, rid, expected_count, max_pages):
    """Read the REST list-assets endpoint in verified order, never truncated embedded arrays."""
    need(0 < expected_count <= 100 * (max_pages - 1),
         'Insufficient asset pagination budget')
    ids = set()
    all_assets = []
    # A full final page requires another explicit empty page for completeness.
    for page in range(1, max_pages + 1):
        response = rest.request('GET', f'{API}{stem}/{rid}/assets?per_page=100&page={page}')
        need(response.status == 200, 'Asset list postflight HTTP failure')
        linked_next = check_link(response, page, 100, expected_path=f'{stem}/{rid}/assets')
        entries = strict_json(response.body)
        need(type(entries) is list and len(entries) <= 100, 'Malformed remote asset page')
        need(len(all_assets) + len(entries) <= expected_count, 'Extra remote asset detected')
        for asset in entries:
            obj(asset, ('id', 'name', 'state', 'size', 'digest'))
            aid = pos_int(asset['id'])
            need(aid not in ids, 'Repeated asset ID in postflight pagination')
            ids.add(aid)
        all_assets.extend(entries)
        if not entries:
            need(not linked_next and len(all_assets) == expected_count,
                 'Incomplete asset inventory or dangling next link')
            return all_assets
        if len(entries) < 100:
            need(not linked_next and page < max_pages, 'Invalid asset page continuation')
            boundary = rest.request('GET',
                f'{API}{stem}/{rid}/assets?per_page=100&page={page+1}')
            need(boundary.status == 200, 'Asset pagination boundary HTTP failure')
            need(not check_link(boundary, page+1, 100,
                                expected_path=f'{stem}/{rid}/assets'),
                 'Asset pagination boundary links to unexpected content')
            need(strict_json(boundary.body) == [] and len(all_assets) == expected_count,
                 'Incomplete or inconsistent asset boundary')
            return all_assets
    raise StageError('Asset pagination budget exhausted without verified empty boundary')


def validate_tag(rest, stem, tag, expected, *, preflight=False):
    ref = rest.request('GET', f'{API}{stem[:-9]}/git/ref/tags/{quote(tag, safe="")}', preflight=preflight)
    need(ref.status == 200, 'Remote tag is absent or inaccessible')
    item = obj(strict_json(ref.body), ('ref', 'object'))
    need(item['ref'] == 'refs/tags/' + tag, 'Remote tag name changed')
    target = obj(item['object'], ('type', 'sha'))
    seen = set()
    for depth in range(8):
        kind, object_sha = target['type'], sha(target['sha'])
        if kind == 'commit':
            need(object_sha == expected, 'Remote tag does not target independently approved SHA')
            return
        need(kind == 'tag' and object_sha not in seen, 'Unresolvable annotated tag')
        seen.add(object_sha)
        response = rest.request('GET', f'{API}{stem[:-9]}/git/tags/{object_sha}', preflight=preflight)
        need(response.status == 200, 'Remote annotated tag cannot be peeled')
        annotated = obj(strict_json(response.body), ('sha', 'object', 'tag'))
        need(sha(annotated['sha']) == object_sha and type(annotated['tag']) is str,
             'Wrong annotated tag object')
        if depth == 0:
            need(annotated['tag'] == tag, 'Annotated tag name mismatch')
        target = obj(annotated['object'], ('type', 'sha'))
    raise StageError('Annotated tag nesting exceeds bound')


def upload_template(release, stem, rid):
    value = obj(release, ('upload_url',))['upload_url']
    need(type(value) is str and value == f'{UPLOADS}{stem}/{rid}/assets{{?name,label}}',
         'Untrusted upload_url; repository, ID or origin mismatch')
    return value.split('{', 1)[0]


def release_identity(value, stem, tag, rid=None):
    r = obj(value, ('id', 'tag_name', 'name', 'draft', 'prerelease', 'url', 'upload_url', 'assets'))
    ident = pos_int(r['id'])
    need(rid is None or ident == rid, 'Created release ID substituted or changed')
    need(r['tag_name'] == tag and r['name'] == tag and r['draft'] is True
         and r['prerelease'] is False and r['url'] == f'{API}{stem}/{ident}'
         and type(r['assets']) is list,
         'Release identity, repository, tag or draft mismatch')
    upload_template(r, stem, ident)
    return ident


def asset_identity(asset, name, size, digest, previous_ids):
    a = obj(asset, ('id', 'name', 'state', 'size', 'digest'))
    aid = pos_int(a['id'])
    need(aid not in previous_ids and a['name'] == name and a['state'] == 'uploaded'
         and type(a['size']) is int and a['size'] == size
         and a['digest'] == 'sha256:' + digest,
         'Asset ID/name/state/size/SHA-256 differs from local bytes')
    return aid


class Journal:
    def __init__(self, path, tag):
        self.path = Path(path)
        self.fd = os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        self.data = {'tag': tag, 'state': 'PREFLIGHT_DENIED'}
        self.update('PREFLIGHT_DENIED')

    def update(self, state, **details):
        self.data.update(details)
        self.data['state'] = state
        value = (json.dumps(self.data, sort_keys=True) + '\n').encode()
        os.lseek(self.fd, 0, os.SEEK_SET)
        os.ftruncate(self.fd, 0)
        os.write(self.fd, value)
        os.fsync(self.fd)

    def close(self):
        os.close(self.fd)


def execute(directory, *, rest=None):
    assets = local_assets(directory)
    repo, tag = os.environ.get('GITHUB_REPOSITORY', ''), os.environ.get('GITHUB_REF_NAME', '')
    token, approved = os.environ.get('GH_TOKEN', ''), os.environ.get('RELEASE_APPROVED_COMMIT_SHA', '')
    need(re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', repo) is not None
         and all(part not in ('.', '..') and part[0].isalnum() for part in repo.split('/'))
         and SAFE.fullmatch(tag) is not None and not tag.endswith('.') and bool(token)
         and not any(c in token for c in ('\n', '\r'))
         and os.environ.get('GH_HOST', 'github.com') == 'github.com',
         'Invalid authenticated GitHub release context')
    approved = sha(approved)  # Must be independently provisioned; GITHUB_SHA alone is insufficient.
    limits = Limits.from_env()
    stem = f'/repos/{repo}/releases'
    if rest is None:
        rest = Rest(token, limits)
    journal_path = os.environ.get('RELEASE_STAGE_JOURNAL')
    if not journal_path:
        journal_path = tempfile.gettempdir() + '/gwc-release-stage-' + os.urandom(12).hex() + '.json'
    try:
        journal = Journal(journal_path, tag)
    except FileExistsError as exc:
        raise StageError('Existing stage journal: do not replay uncertain operation') from exc
    try:
        repo_response = rest.request('GET', f'{API}/repos/{repo}', preflight=True)
        need(repo_response.status == 200, 'Repository authentication failed')
        repo_item = obj(strict_json(repo_response.body), ('full_name', 'permissions'))
        permissions = obj(repo_item['permissions'], ('push',))
        need(type(repo_item['full_name']) is str
             and repo_item['full_name'].casefold() == repo.casefold()
             and permissions['push'] is True, 'Repository identity or push visibility unverified')
        validate_tag(rest, stem, tag, approved, preflight=True)
        list_absence(rest, stem, tag, limits.pages)
        bytag = rest.request('GET', f'{API}{stem}/tags/{quote(tag, safe="")}', preflight=True)
        need(bytag.status == 404, 'Existing release or by-tag HTTP failure')
        missing = obj(strict_json(bytag.body), ('message',))
        need(missing['message'] == 'Not Found' and missing.get('status', '404') == '404',
             'Ambiguous by-tag 404')
        validate_tag(rest, stem, tag, approved, preflight=True)
        journal.update('ABSENCE_CONFIRMED', approved_sha=approved)
        # REST may create a missing tag implicitly. Independent tag GET checks above
        # and later are mandatory, and target_commitish is pinned defensively.
        journal.update('CREATE_ATTEMPTED')  # Must persist before issuing any POST.
        response = rest.request('POST', f'{API}{stem}', payload={
            'tag_name': tag, 'target_commitish': approved, 'name': tag,
            'draft': True, 'prerelease': False, 'generate_release_notes': True,
            'make_latest': 'false'})
        need(response.status == 201, 'Release create returned non-201: manual review')
        created = strict_json(response.body)
        rid = release_identity(created, stem, tag)
        journal.update('CREATE_ID_CONFIRMED', release_id=rid)
        upload_base = upload_template(created, stem, rid)
        posted_ids = {}
        for name, (path, size, digest) in assets.items():
            journal.update('UPLOAD_IN_PROGRESS', current_asset=name)
            uploaded = rest.request('POST', upload_base + '?name=' + quote(name, safe=''),
                                    file_path=path, size=size, expected_digest=digest)
            need(uploaded.status == 201, 'Asset upload returned non-201: manual review')
            remote = strict_json(uploaded.body)
            posted_ids[name] = asset_identity(remote, name, size, digest, set(posted_ids.values()))
            journal.update('CREATE_ID_CONFIRMED', current_asset=None, uploaded_ids=posted_ids)
        post = rest.request('GET', f'{API}{stem}/{rid}')
        need(post.status == 200, 'Postflight ID lookup failed: manual review')
        verified = strict_json(post.body)
        release_identity(verified, stem, tag, rid)
        # Release GET establishes the *release* ID. Its embedded assets array
        # is not an exhaustive paginated asset inventory. Query the dedicated
        # list-assets endpoint tied to the same immutable release ID instead.
        remote_assets = list_release_assets(rest, stem, rid, len(assets), limits.pages)
        remote_ids, remote_names = set(), set()
        for asset in remote_assets:
            name = asset['name']
            need(type(name) is str and name in assets and name not in remote_names,
                 'Unknown/duplicate remote asset name')
            _, size, digest = assets[name]
            aid = asset_identity(asset, name, size, digest, remote_ids)
            need(aid == posted_ids[name], 'Postflight asset ID differs from uploaded asset')
            remote_names.add(name)
            remote_ids.add(aid)
        need(remote_names == set(assets), 'Remote asset inventory incomplete')
        validate_tag(rest, stem, tag, approved)
        for path, _, digest in assets.values():
            h = hashlib.sha256()
            with open_safe(path) as f:
                while chunk := f.read(1024 * 1024):
                    h.update(chunk)
                need(f.unchanged() and h.hexdigest() == digest,
                     'Local asset changed before final verification')
        journal.update('DRAFT_VERIFIED', current_asset=None, verified_assets=len(assets))
        print('DRAFT_STAGED_ASSET_INVENTORY_VERIFIED=' + str(len(assets)))
        print('DRAFT_STAGED_BINARY_DIGEST_VERIFIED=' + str(len(assets)))
        print('RELEASE_STAGE_STATE=DRAFT_VERIFIED RELEASE_ID=' + str(rid))
    except Exception as exc:
        if journal.data['state'] in ('PREFLIGHT_DENIED', 'ABSENCE_CONFIRMED'):
            journal.update('PREFLIGHT_DENIED')
        else:
            journal.update('MANUAL_REVIEW_REQUIRED', failure_type=type(exc).__name__)
        raise
    finally:
        journal.close()


def main():
    try:
        need(len(sys.argv) <= 2, 'Usage: stage_release_draft.py [release-assets]', 2)
        execute(Path(sys.argv[1] if len(sys.argv) == 2 else 'release-assets'))
        return 0
    except StageError as exc:
        print('RELEASE_STAGE_FAILED: ' + str(exc), file=sys.stderr)
        return exc.exit_code
    except Exception as exc:
        # Deliberately no exception repr: runtime errors must never dump tokens.
        print('RELEASE_STAGE_FAILED: unexpected ' + type(exc).__name__ +
              '; manual inspection of private stage journal required', file=sys.stderr)
        return 3


if __name__ == '__main__':
    sys.exit(main())
