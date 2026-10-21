"""R6 security regressions: stateful synthetic REST + real local TLS wire tests.

Never uses GitHub hosts in the real network, accounts, or real credentials.
"""
import contextlib
import copy
import hashlib
import http.server
import io
import json
import os
from pathlib import Path
import shutil
import socket
import ssl
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
import stage_release_draft as r6

REPO = 'synthetic/release-fixture'
TAG = 'v2.3.0'
APPROVED = 'a' * 40
ANNOTATED = 'b' * 40
STEM = '/repos/' + REPO + '/releases'
TOKEN = 'R6_SYNTHETIC_NO_REAL_ACCESS'


def entry(i, tag=None, name='Release', draft=False):
    return {'id': i, 'tag_name': tag or 'old-' + str(i), 'name': name,
            'draft': draft, 'prerelease': False}


def release(i, assets=None):
    return {'id': i, 'tag_name': TAG, 'name': TAG, 'draft': True,
            'prerelease': False, 'url': r6.API + STEM + '/' + str(i),
            'upload_url': r6.UPLOADS + STEM + '/' + str(i) + '/assets{?name,label}',
            'assets': assets if assets is not None else []}


def response(status, data, headers=(), raw=False):
    body = data if raw else json.dumps(data, separators=(',', ':')).encode()
    return r6.Response(status, (('Content-Type', 'application/json'),) + tuple(headers), body)


class MemoryRest:
    """Mutable server state; no network; keeps actual created and uploaded identities."""
    def __init__(self, mode=None):
        self.mode = mode or {}
        self.calls = []
        self.initial = copy.deepcopy(self.mode.get('initial', []))
        self.created = {}
        self.posts = 0
        self.uploads = []
        self.tag_reads = 0
        self.shift_performed = False

    def request(self, method, url, **kwargs):
        path = urlsplit(url).path
        query = parse_qs(urlsplit(url).query)
        self.calls.append((method, url, kwargs.get('preflight', False)))
        if method == 'GET' and path == '/repos/' + REPO:
            return response(200, {'full_name': REPO if not self.mode.get('wrong_repo') else 'other/repo',
                                  'permissions': {'push': not self.mode.get('no_push')}})
        if method == 'GET' and path == '/repos/' + REPO + '/git/ref/tags/' + TAG:
            self.tag_reads += 1
            if self.mode.get('missing_tag'):
                return response(404, {'message': 'Not Found'})
            kind = 'tag' if self.mode.get('annotated') else 'commit'
            rev = self.mode.get('wrong_sha', APPROVED)
            return response(200, {'ref': 'refs/tags/' + TAG,
                                  'object': {'type': kind, 'sha': ANNOTATED if kind == 'tag' else rev}})
        if method == 'GET' and path == '/repos/' + REPO + '/git/tags/' + ANNOTATED:
            return response(200, {'sha': ANNOTATED,
                                  'tag': 'other-tag' if self.mode.get('wrong_annotated') else TAG,
                                  'object': {'type': 'commit', 'sha': self.mode.get('wrong_sha', APPROVED)}})
        if method == 'GET' and path == STEM:
            page = int(query['page'][0])
            inventory = self.initial + list(self.created.values())
            # Existing drafts remain in list even when get-by-tag returns 404.
            items = copy.deepcopy(inventory[(page - 1) * 100:page * 100])
            if self.mode.get('endless'):
                items = [entry((page - 1) * 100 + i + 1) for i in range(100)]
            if self.mode.get('delete_shift') and page == 1 and not self.shift_performed:
                self.initial.pop(0)
                self.shift_performed = True
            if self.mode.get('insert_shift') and page == 1 and not self.shift_performed:
                self.initial.insert(0, entry(999999, 'added-concurrently'))
                self.shift_performed = True
            if self.mode.get('drop_name'):
                for item in items:
                    item.pop('name', None)
            if self.mode.get('extra_page') and page == 2:
                items = [entry(201)]
            if self.mode.get('list_bad_json') and page == 1:
                return response(200, b'[] trailing', raw=True)
            links = ()
            if self.mode.get('skip_link') and page == 1:
                links = (('Link', f'<{r6.API}{STEM}?per_page=100&page=3>; rel="next"'),)
            elif self.mode.get('link_ok') and len(items) == 100:
                links = (('Link', f'<{r6.API}{STEM}?per_page=100&page={page+1}>; rel="next"'),)
            return response(200, items, links)
        if method == 'GET' and path == STEM + '/tags/' + TAG:
            return response(404, {'message': 'Not Found', 'status': '404'})
        if method == 'POST' and path == STEM:
            self.posts += 1
            if self.mode.get('create422'):
                return response(422, {'message': 'Validation failed'})
            rid = 100001
            self.created[rid] = release(rid)
            if self.mode.get('create_drop'):
                raise r6.StageError('Synthetic accepted POST with response lost')
            result = copy.deepcopy(self.created[rid])
            if self.mode.get('create_wrong_id'):
                result['id'] = 100101
            if self.mode.get('evil_upload_url'):
                result['upload_url'] = 'https://evil.invalid/repos/synthetic/release-fixture/releases/100001/assets{?name,label}'
            if self.mode.get('upload_wrong_id'):
                result['upload_url'] = r6.UPLOADS + STEM + '/100101/assets{?name,label}'
            if self.mode.get('create_ambiguous'):
                return response(201, json.dumps(result).encode() + b'\0', raw=True)
            return response(201, result)
        if method == 'POST' and path.startswith(STEM + '/') and path.endswith('/assets'):
            rid = int(path.removeprefix(STEM + '/').split('/')[0])
            assert rid in self.created, 'Unbound asset upload happened'
            name = query['name'][0]
            p = kwargs['file_path']
            data = Path(p).read_bytes()
            self.uploads.append((rid, name))
            if self.mode.get('upload_drop'):
                raise r6.StageError('Synthetic asset accepted but reply lost')
            asset = {'id': 200001 + len(self.uploads), 'name': name, 'state': 'uploaded',
                     'size': len(data), 'digest': 'sha256:' + hashlib.sha256(data).hexdigest()}
            if self.mode.get('bad_upload_digest'):
                asset['digest'] = 'sha256:' + '0' * 64
            self.created[rid]['assets'].append(copy.deepcopy(asset))
            return response(201, asset)
        if method == 'GET' and path.startswith(STEM + '/') and path.endswith('/assets'):
            rid = int(path.removeprefix(STEM + '/').split('/')[0])
            assert rid in self.created
            page = int(query['page'][0])
            items = copy.deepcopy(self.created[rid]['assets'][(page-1)*100:page*100])
            if self.mode.get('post_bad_digest') and items:
                items[0]['digest'] = 'sha256:' + 'f' * 64
            if self.mode.get('post_wrong_asset_id') and items:
                items[0]['id'] += 100
            if self.mode.get('post_extra_asset') and page == 1:
                items.append({'id': 9999, 'name': 'extra.zip', 'state': 'uploaded',
                              'size': 1, 'digest': 'sha256:' + '0' * 64})
            if self.mode.get('post_asset_missing') and page == 1:
                items = items[:-1]
            if self.mode.get('post_assets_wrong_page') and page == 1:
                return response(200, items, (('Link', f'<{r6.API}{STEM}/{rid}/assets?per_page=100&page=3>; rel="next"'),))
            return response(200, items)
        if method == 'GET' and path.startswith(STEM + '/'):
            rid = int(path.removeprefix(STEM + '/'))
            if self.mode.get('replace_created'):
                self.created[100101] = release(100101, self.created[100001]['assets'])
                del self.created[100001]
            if rid not in self.created:
                return response(404, {'message': 'Not Found'})
            result = copy.deepcopy(self.created[rid])
            if self.mode.get('wrong_post_id'):
                result['id'] = 100101
            if self.mode.get('post_bad_digest'):
                result['assets'][0]['digest'] = 'sha256:' + 'f' * 64
            if self.mode.get('post_wrong_asset_id'):
                result['assets'][0]['id'] += 100
            if self.mode.get('post_extra_asset'):
                result['assets'].append({'id': 9999, 'name': 'extra.zip', 'state': 'uploaded',
                                         'size': 1, 'digest': 'sha256:' + '0' * 64})
            if self.mode.get('post_published'):
                result['draft'] = False
            if self.mode.get('post_ambiguous'):
                return response(200, json.dumps(result).encode() + b' {"other":2}', raw=True)
            if self.mode.get('post_duplicate'):
                return response(200, b'{"DRAFT":false,' + json.dumps(result).encode()[1:], raw=True)
            return response(200, result)
        raise AssertionError('Unexpected mock route: ' + method + ' ' + url)


class RestSafetyTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='r6-rest-unit-')
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.assets = self.root / 'assets'
        self.assets.mkdir()
        data = b'R6 synthetic binary payload\n'
        (self.assets / 'payload.zip').write_bytes(data)
        (self.assets / 'checksums.txt').write_text(hashlib.sha256(data).hexdigest() + '  payload.zip\n')
        self.counter = 0
        self.env = patch.dict(os.environ, {
            'GITHUB_REPOSITORY': REPO, 'GITHUB_REF_NAME': TAG, 'GH_HOST': 'github.com',
            'GH_TOKEN': TOKEN, 'RELEASE_APPROVED_COMMIT_SHA': APPROVED,
            'RELEASE_MAX_PAGES': '32', 'RELEASE_MAX_TOTAL_BYTES': str(32 * 1024 * 1024),
            'RELEASE_MAX_RESPONSE_BYTES': str(8 * 1024 * 1024),
        })
        self.env.start()
        self.addCleanup(self.env.stop)

    def run_stage(self, rest):
        self.counter += 1
        state = self.root / ('state-%d.json' % self.counter)
        with patch.dict(os.environ, {'RELEASE_STAGE_JOURNAL': str(state)}):
            out = io.StringIO()
            try:
                with contextlib.redirect_stdout(out):
                    r6.execute(self.assets, rest=rest)
                err = None
            except (r6.StageError, OSError) as exc:
                err = exc
        result = json.loads(state.read_text()) if state.exists() else None
        return out.getvalue(), err, result

    def block(self, mode, stage='PREFLIGHT_DENIED', mutations=0):
        mock = MemoryRest(mode)
        output, error, journal = self.run_stage(mock)
        self.assertIsNotNone(error, output)
        self.assertEqual(mock.posts, mutations)
        self.assertEqual(journal['state'], stage)
        self.assertNotIn('DRAFT_STAGED', output)
        return mock, journal

    def test_success_id_bound_binary_digest_and_persistent_journal(self):
        mock = MemoryRest()
        stdout, error, state = self.run_stage(mock)
        self.assertIsNone(error)
        self.assertIn('DRAFT_STAGED_BINARY_DIGEST_VERIFIED=2', stdout)
        self.assertEqual((mock.posts, len(mock.uploads), len(mock.created)), (1, 2, 1))
        self.assertEqual({rid for rid, _ in mock.uploads}, {100001})
        self.assertEqual(state['release_id'], 100001)
        self.assertEqual(state['state'], 'DRAFT_VERIFIED')
        self.assertEqual(len(state['uploaded_ids']), 2)
        self.assertEqual(mock.tag_reads, 3)

    def test_create_A_postflight_B_replaced_and_wrong_id(self):
        for mode in ({'replace_created': True}, {'wrong_post_id': True}):
            with self.subTest(mode=mode):
                mock, state = self.block(mode, 'MANUAL_REVIEW_REQUIRED', 1)
                self.assertEqual({rid for rid, _ in mock.uploads}, {100001})
                self.assertEqual(state['release_id'], 100001)

    def test_create_response_wrong_or_ambiguous(self):
        for mode in ({'create_wrong_id': True}, {'create_ambiguous': True},
                     {'create422': True}, {'create_drop': True}):
            with self.subTest(mode=mode):
                self.block(mode, 'MANUAL_REVIEW_REQUIRED', 1)

    def test_upload_id_host_and_response_loss(self):
        for mode in ({'evil_upload_url': True}, {'upload_wrong_id': True},
                     {'upload_drop': True}, {'bad_upload_digest': True}):
            with self.subTest(mode=mode):
                mock, _ = self.block(mode, 'MANUAL_REVIEW_REQUIRED', 1)
                if 'evil_upload_url' in mode or 'upload_wrong_id' in mode:
                    self.assertEqual(mock.uploads, [])

    def test_POST_rest_original_ambiguous(self):
        for mode in ({'post_ambiguous': True}, {'post_duplicate': True}):
            with self.subTest(mode=mode):
                self.block(mode, 'MANUAL_REVIEW_REQUIRED', 1)
        for bad in (b'{} xyz', b'{}\0', b'{}{}', b'{"draft":false,"draft":true}',
                    b'{"DRAFT":false,"draft":true}', b'\xff', b'[NaN]', b'[Infinity]'):
            with self.subTest(bad=bad):
                with self.assertRaises(r6.StageError):
                    r6.strict_json(bad)

    def test_assets_digest_names_ids_and_state(self):
        for key in ('post_bad_digest', 'post_wrong_asset_id', 'post_extra_asset', 'post_published',
                    'post_asset_missing', 'post_assets_wrong_page'):
            with self.subTest(key=key):
                self.block({key: True}, 'MANUAL_REVIEW_REQUIRED', 1)

    def test_existing_draft_and_collision_in_first_middle_last_page(self):
        for position in (0, 150, 200):
            records = [entry(i + 1) for i in range(201)]
            records[position] = entry(500000, TAG, TAG, True)
            with self.subTest(position=position):
                self.block({'initial': records})
        self.block({'initial': [entry(1, 'old-tag', TAG)]})
        self.block({'initial': [entry(1, 'V2.3.0', 'Other')]})

    def test_page_skipping_link_refused_no_post(self):
        self.block({'skip_link': True, 'initial': [entry(i+1) for i in range(101)]})

    def test_explicit_consecutive_pages_and_link_valid(self):
        mock = MemoryRest({'link_ok': True, 'initial': [entry(i+1) for i in range(201)]})
        _, error, _ = self.run_stage(mock)
        self.assertIsNone(error)
        pages = [urlsplit(url).query for method, url, _ in mock.calls
                 if method == 'GET' and urlsplit(url).path == STEM]
        self.assertEqual(pages, ['per_page=100&page=1', 'per_page=100&page=2',
                                 'per_page=100&page=3', 'per_page=100&page=4'])

    def test_observable_concurrent_shift_is_blocked(self):
        # An insertion before page 2 duplicates the boundary record.
        self.block({'insert_shift': True, 'initial': [entry(i+1) for i in range(201)]})

    def test_unobservable_concurrent_deletion_is_a_documented_residual(self):
        # A deletion shifts the draft from index 100 to index 99 after reading
        # page 1. No offset-paginated algorithm has an atomic snapshot here.
        records = [entry(i+1) for i in range(201)]
        records[100] = entry(500000, TAG, TAG, True)
        mock = MemoryRest({'delete_shift': True, 'initial': records})
        out, err, journal = self.run_stage(mock)
        self.assertTrue(mock.shift_performed)
        self.assertIsNone(err, 'Residual risk fixture should exhibit missed draft')
        self.assertEqual((mock.posts, journal['state']), (1, 'DRAFT_VERIFIED'))
        self.assertIn('DRAFT_STAGED', out)

    def test_endless_list_bound_before_overrequest(self):
        with patch.dict(os.environ, {'RELEASE_MAX_PAGES': '3'}):
            mock = MemoryRest({'endless': True})
            _, error, journal = self.run_stage(mock)
        self.assertIsNotNone(error)
        self.assertEqual(journal['state'], 'PREFLIGHT_DENIED')
        pages = [v for method, v, _ in mock.calls if urlsplit(v).path == STEM and method == 'GET']
        self.assertEqual(len(pages), 3)
        self.assertEqual(mock.posts, 0)

    def test_invalid_list_schema_duplicate_and_missing_name_vs_null(self):
        for records in ([{'id': 2, 'tag_name': 'old', 'draft': False, 'prerelease': False}],
                        [entry(1, name=12)], [entry(1), entry(1, 'other')],
                        [entry(1, 'old-a'), entry(2, 'old-a')]):
            with self.subTest(records=records):
                self.block({'initial': records})
        name_null = entry(1)
        name_null['name'] = None
        stdout, error, _ = self.run_stage(MemoryRest({'initial': [name_null]}))
        self.assertIsNone(error)
        self.assertIn('DRAFT_STAGED', stdout)
        self.block({'drop_name': True, 'initial': [entry(1, 'old-a', TAG)]})

    def test_missing_wrong_annotated_and_lightweight_tag(self):
        for mode in ({'missing_tag': True}, {'wrong_sha': 'f' * 40},
                     {'annotated': True, 'wrong_annotated': True},
                     {'annotated': True, 'wrong_sha': 'f' * 40}, {'no_push': True},
                     {'wrong_repo': True}):
            with self.subTest(mode=mode):
                self.block(mode)
        for mode in ({}, {'annotated': True}):
            stdout, err, _ = self.run_stage(MemoryRest(mode))
            self.assertIsNone(err)
            self.assertIn('DRAFT_STAGED', stdout)

    def test_partial_create_retry_state_preserved(self):
        remote = MemoryRest({'create_drop': True})
        _, first_err, state = self.run_stage(remote)
        self.assertIsNotNone(first_err)
        self.assertEqual(state['state'], 'MANUAL_REVIEW_REQUIRED')
        self.assertEqual(remote.posts, 1)
        remote.mode.pop('create_drop')
        # Different run: the persistent draft appears in exhaustive list.
        _, again, new_state = self.run_stage(remote)
        self.assertIsNotNone(again)
        self.assertEqual(new_state['state'], 'PREFLIGHT_DENIED')
        self.assertEqual(remote.posts, 1)

    def test_existing_journal_blocks_replay_even_when_remote_hidden(self):
        remote = MemoryRest()
        self.counter += 1
        already = self.root / ('state-%d.json' % self.counter)
        already.write_text('{"state":"CREATE_ATTEMPTED"}\n')
        with patch.dict(os.environ, {'RELEASE_STAGE_JOURNAL': str(already)}):
            with self.assertRaises(r6.StageError):
                r6.execute(self.assets, rest=remote)
        self.assertEqual(remote.calls, [])

    def test_unchecked_modified_symlink_files_never_contact_network(self):
        remote = MemoryRest()
        (self.assets / 'payload.zip').write_bytes(b'altered')
        with self.assertRaises(r6.StageError):
            r6.execute(self.assets, rest=remote)
        self.assertEqual(remote.calls, [])
        (self.assets / 'payload.zip').unlink()
        (self.assets / 'payload.zip').symlink_to(self.assets / 'checksums.txt')
        with self.assertRaises(r6.StageError):
            r6.execute(self.assets, rest=remote)
        self.assertEqual(remote.calls, [])

    def test_missing_approval_without_contact(self):
        with patch.dict(os.environ, {'RELEASE_APPROVED_COMMIT_SHA': ''}):
            with self.assertRaises(r6.StageError):
                r6.execute(self.assets, rest=MemoryRest())

class TLSLocalTests(unittest.TestCase):
    """Actual TLS/HTTPResponse/client process; no GH CLI and no external DNS."""
    @classmethod
    def setUpClass(cls):
        if not shutil.which('openssl'):
            raise unittest.SkipTest('openssl missing for isolated HTTPS test CA')
        cls.tmp = tempfile.TemporaryDirectory(prefix='r6-wire-')
        cls.dir = Path(cls.tmp.name)
        key, cert = cls.dir / 'key.pem', cls.dir / 'cert.pem'
        subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
                        '-days', '1', '-keyout', str(key), '-out', str(cert),
                        '-subj', '/CN=api.github.com',
                        '-addext', 'subjectAltName=DNS:api.github.com,DNS:uploads.github.com'],
                       check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        cls.cert = cert
        (cls.dir / 'sitecustomize.py').write_text('''
import socket,os
_original=socket.create_connection
def _isolated(address,*args,**kwargs):
    host,port=address
    if host not in ('api.github.com','uploads.github.com') or port!=443:
        raise OSError('External networking forbidden by R6 test harness')
    return _original(('127.0.0.1',int(os.environ['R6_TEST_PORT'])),*args,**kwargs)
socket.create_connection=_isolated
''')

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def setUp(self):
        self.calls = []
        self.creates = []
        self.assets_remote = []
        self.case = None
        self.payload = b'R6 real TLS-only binary payload'
        self.work = tempfile.TemporaryDirectory(prefix='r6-wire-case-')
        self.addCleanup(self.work.cleanup)
        self.dir_case = Path(self.work.name)
        self.assets = self.dir_case / 'assets'
        self.assets.mkdir()
        (self.assets / 'good.zip').write_bytes(self.payload)
        (self.assets / 'checksums.txt').write_text(hashlib.sha256(self.payload).hexdigest() + '  good.zip\n')
        owner = self

        class Handler(http.server.BaseHTTPRequestHandler):
            protocol_version = 'HTTP/1.1'
            def log_message(self, *_):
                pass
            def do_GET(self): self.route()
            def do_POST(self): self.route()
            def route(self):
                p = urlsplit(self.path)
                length = int(self.headers.get('Content-Length', '0'))
                body = self.rfile.read(length) if length else b''
                if self.headers.get('Authorization') != 'Bearer ' + TOKEN:
                    return self.reply(403, {'message': 'not synthetic auth'})
                owner.calls.append((self.command, p.path, p.query, self.headers.get('Host')))
                if p.path == '/repos/' + REPO:
                    return self.reply(200, {'full_name': REPO, 'permissions': {'push': True}})
                if p.path == '/repos/' + REPO + '/git/ref/tags/' + TAG:
                    if owner.case == 'tag_absent':
                        return self.reply(404, {'message': 'Not Found'})
                    return self.reply(200, {'ref': 'refs/tags/' + TAG,
                                            'object': {'type': 'commit', 'sha': APPROVED}})
                if p.path == STEM and self.command == 'GET':
                    page = int(parse_qs(p.query)['page'][0])
                    if owner.case == 'large_page':
                        return self.reply(200, [], extra=[('Content-Length', '99999999')])
                    if owner.case == 'double_length':
                        return self.reply(200, [], extra=[('Content-Length', '2'), ('Content-Length', '2')])
                    if owner.case == 'te_cl':
                        return self.reply(200, [], extra=[('Content-Length', '2'), ('Transfer-Encoding', 'chunked')])
                    if owner.case == 'redirect':
                        return self.reply(302, {'message':'redirect'}, extra=[('Location', 'https://malicious.invalid/steal')])
                    if owner.case == 'invalid_utf8':
                        return self.reply(200, raw=b'[\xff]')
                    if owner.case == 'two_json':
                        return self.reply(200, raw=b'[] []')
                    if owner.case == 'slow_page':
                        time.sleep(1.3)
                    if owner.case == 'jump' and page == 1:
                        return self.reply(200, [entry(i + 1) for i in range(100)],
                                          extra=[('Link', f'<{r6.API}{STEM}?per_page=100&page=3>; rel="next"')])
                    if owner.case == 'draft_page2' and page == 1:
                        return self.reply(200, [entry(i + 1) for i in range(100)])
                    if owner.case == 'draft_page2' and page == 2:
                        return self.reply(200, [entry(201, TAG, TAG, True)])
                    if owner.creates:
                        return self.reply(200, [release(owner.creates[0], owner.assets_remote)])
                    return self.reply(200, [])
                if p.path == STEM + '/tags/' + TAG:
                    return self.reply(404, {'message': 'Not Found', 'status': '404'})
                if p.path == STEM and self.command == 'POST':
                    owner.creates.append(100001)
                    owner.create_payload = json.loads(body)
                    obj = release(100001)
                    if owner.case == 'create_drop':
                        self.close_connection = True
                        self.connection.shutdown(socket.SHUT_RDWR)
                        self.connection.close()
                        return
                    raw = json.dumps(obj).encode()
                    if owner.case == 'create_nul':
                        raw += b'\0'
                    return self.reply(201, raw=raw)
                if p.path == STEM + '/100001/assets' and self.command == 'POST':
                    name = parse_qs(p.query)['name'][0]
                    remote_asset = {'id': 300001 + len(owner.assets_remote), 'name': name,
                                    'state': 'uploaded', 'size': len(body),
                                    'digest': 'sha256:' + hashlib.sha256(body).hexdigest()}
                    owner.assets_remote.append(remote_asset)
                    if owner.case == 'upload_drop':
                        self.close_connection = True
                        self.connection.shutdown(socket.SHUT_RDWR)
                        self.connection.close()
                        return
                    return self.reply(201, remote_asset)
                if p.path == STEM + '/100001/assets' and self.command == 'GET':
                    page = int(parse_qs(p.query)['page'][0])
                    items = copy.deepcopy(owner.assets_remote[(page-1)*100:page*100])
                    if owner.case == 'post_wrong_digest' and items:
                        items[0]['digest'] = 'sha256:' + 'f'*64
                    if owner.case == 'extra_asset' and page == 1:
                        items.append({'id': 909090, 'name': 'unexpected.zip',
                                      'state': 'uploaded', 'size': 10,
                                      'digest': 'sha256:' + 'f'*64})
                    return self.reply(200, items)
                if p.path == STEM + '/100001' and self.command == 'GET':
                    if owner.case == 'replace_id':
                        return self.reply(404, {'message': 'Not Found'})
                    value = release(100001, owner.assets_remote)
                    raw = json.dumps(value).encode()
                    if owner.case == 'post_trailing': raw += b' garbage'
                    if owner.case == 'post_duplicate': raw = b'{"draft":false,' + raw[1:]
                    if owner.case == 'post_wrong_digest': value['assets'][0]['digest'] = 'sha256:' + 'f'*64; raw = json.dumps(value).encode()
                    return self.reply(200, raw=raw)
                raise AssertionError('Unexpected local TLS route: ' + self.path)
            def reply(self, status, body=None, raw=None, extra=()):
                content = raw if raw is not None else json.dumps(body).encode()
                self.send_response(status)
                self.send_header('Content-Type', 'application/json')
                for k, v in extra: self.send_header(k, v)
                if not any(k.lower() == 'content-length' for k, v in extra):
                    self.send_header('Content-Length', str(len(content)))
                self.send_header('Connection', 'close')
                self.end_headers()
                try: self.wfile.write(content)
                except (BrokenPipeError, ConnectionResetError, ssl.SSLError): pass
                self.close_connection = True

        self.server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(str(self.cert), str(self.dir / 'key.pem'))
        self.server.socket = ctx.wrap_socket(self.server.socket, server_side=True)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.stop_server)

    def stop_server(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)

    def invoke(self, mode=None, **limits):
        self.case = mode
        env = dict(os.environ)
        env.update({'PYTHONPATH': str(self.dir), 'SSL_CERT_FILE': str(self.cert),
                    'R6_TEST_PORT': str(self.server.server_port),
                    'GITHUB_REPOSITORY': REPO, 'GITHUB_REF_NAME': TAG,
                    'GH_HOST': 'github.com', 'GH_TOKEN': TOKEN,
                    'RELEASE_APPROVED_COMMIT_SHA': APPROVED,
                    'RELEASE_STAGE_JOURNAL': str(self.dir_case / 'state.json')})
        env.update(limits)
        p = subprocess.run(['bash', str(ROOT / 'scripts/stage-release-draft.sh'), str(self.assets)],
                           cwd=self.dir_case, env=env, capture_output=True, text=True, timeout=10)
        state = json.loads((self.dir_case / 'state.json').read_text())
        return p, state

    def test_real_tls_client_success_creates_A_uploads_A_verifies_A(self):
        run, state = self.invoke()
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertEqual(self.creates, [100001])
        self.assertEqual(len(self.assets_remote), 2)
        self.assertEqual(state['state'], 'DRAFT_VERIFIED')
        self.assertIn('BINARY_DIGEST_VERIFIED=2', run.stdout)
        self.assertEqual(sum(c[0] == 'POST' and c[1] == STEM for c in self.calls), 1)
        self.assertTrue(all(x[3].startswith('uploads.github.com') for x in self.calls if x[0] == 'POST' and x[1].endswith('/assets')))

    def test_local_wire_r5_counterexamples_now_fail(self):
        for mode in ('post_trailing', 'post_duplicate', 'replace_id', 'create_nul',
                     'create_drop', 'upload_drop', 'post_wrong_digest', 'extra_asset'):
            with self.subTest(mode=mode):
                # isolate mutable state across successive local servers
                if self.creates:
                    self.creates.clear(); self.assets_remote.clear(); self.calls.clear()
                (self.dir_case / 'state.json').unlink(missing_ok=True)
                run, journal = self.invoke(mode)
                self.assertNotEqual(run.returncode, 0, run.stdout)
                self.assertEqual(journal['state'], 'MANUAL_REVIEW_REQUIRED')
                self.assertEqual(self.creates, [100001])

    def test_real_wire_budget_tag_and_page_jump_prevent_create(self):
        for mode, limits in (('tag_absent', {}), ('jump', {}),
                             ('large_page', {'RELEASE_MAX_RESPONSE_BYTES': '2048'}),
                             ('slow_page', {'RELEASE_REQUEST_TIMEOUT': '1'}),
                             ('draft_page2', {}), ('double_length', {}),
                             ('te_cl', {}), ('redirect', {}), ('invalid_utf8', {}),
                             ('two_json', {})):
            with self.subTest(mode=mode):
                (self.dir_case / 'state.json').unlink(missing_ok=True)
                run, journal = self.invoke(mode, **limits)
                self.assertNotEqual(run.returncode, 0, run.stdout)
                self.assertEqual(journal['state'], 'PREFLIGHT_DENIED')
                self.assertEqual(self.creates, [])


if __name__ == '__main__':
    unittest.main()
