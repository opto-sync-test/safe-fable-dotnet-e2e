#!/usr/bin/env python3
"""Source-free golden ABI contract. NOT a compiler or guest runtime test."""
import json
from pathlib import Path
import re
import unittest

DATA = Path(__file__).resolve().parent / 'nominal_method_slot_abi_v1.json'
PRIMITIVES = {'bool', 'int', 'uint', 'string', 'i8', 'u8', 'i16', 'u16',
              'i32', 'u32', 'i64', 'u64', 'f64'}
ENUM = re.compile(r'[A-Za-z_][A-Za-z0-9_./:-]*::[A-Za-z_][A-Za-z0-9_]*\Z')


def checked(value, bound):
    if not isinstance(value, str) or not value or value.isspace() or any(ord(c) < 32 or ord(c) == 127 for c in value):
        raise ValueError('missing or control-bearing identifier')
    raw = value.encode('utf-8', errors='strict')
    if len(raw) > bound:
        raise ValueError('identifier exceeds byte limit')
    return f'{len(raw)}_{raw.hex()}$'


def link(case):
    if not isinstance(case, dict):
        raise ValueError('nominal ABI record must be a mapping')
    if not {'owner', 'domain', 'name', 'positions'}.issubset(case):
        raise ValueError('nominal ABI record is missing a required field')
    owner = checked(case['owner'], 1024)
    domain = case['domain']
    if domain not in ('INSTANCE', 'STATIC'):
        raise ValueError('invalid domain')
    name = checked(case['name'], 256)
    positions = case['positions']
    if not isinstance(positions, list) or len(positions) > 64:
        raise ValueError('arity bound')
    symbol = '$methodoverload$v1$' + owner + checked(domain, 8) + name + str(len(positions)) + '$'
    for position in positions:
        if not isinstance(position, dict) or set(position) != {'kind', 'id'}:
            raise ValueError('malformed nominal ABI parameter record')
        kind, identity = position['kind'], position['id']
        if not isinstance(kind, str) or not isinstance(identity, str):
            raise ValueError('non-string nominal ABI parameter identity')
        if kind == 'PRIMITIVE':
            if identity not in PRIMITIVES:
                raise ValueError('invalid primitive')
        elif kind == 'ENUM':
            if not isinstance(identity, str) or not ENUM.fullmatch(identity) or '::::' in identity:
                raise ValueError('invalid nominal enum identity')
        else:
            raise ValueError('invalid position kind')
        symbol += checked(kind, 9) + checked(identity, 1024)
    return symbol


def normalize_compiler_factory(case):
    # This stage is distinct from the public aggregate ABI boundary. Java
    # Position canonicalizes String; the LLVM signature() factory does too.
    # 'layer' is fixture metadata, NOT an authorization or provenance token.
    if not isinstance(case, dict) or case.get('layer') != 'trusted-compiler-signature-factory':
        raise ValueError('not a canonicalization fixture')
    result = {k: v for k, v in case.items() if k != 'layer'}
    if not isinstance(result.get('positions'), list):
        raise ValueError('invalid compiler signature positions')
    positions = []
    for position in result['positions']:
        if not isinstance(position, dict) or set(position) != {'kind', 'id'}:
            raise ValueError('invalid compiler factory position')
        kind, identity = position['kind'], position['id']
        if not isinstance(kind, str) or not isinstance(identity, str):
            raise ValueError('invalid compiler factory identity')
        positions.append({'kind': kind, 'id':
                          'string' if kind == 'PRIMITIVE' and identity == 'String' else identity})
    result['positions'] = positions
    return result



class GoldenContract(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.doc = json.loads(DATA.read_text(encoding='utf-8'))

    def test_version_and_nonclaim(self):
        self.assertEqual(self.doc['version'], 'nominal-method-slot-abi-v1')
        self.assertEqual(self.doc['evidence'], 'reference-only-not-backend-execution')
        self.assertEqual(set(self.doc['backend_expectations']), {'java', 'llvm', 'net', 'wasm', 'forge'})
        self.assertEqual(self.doc['backend_expectations']['net'], 'reject-unimplemented')
        self.assertEqual(self.doc['backend_expectations']['wasm'], 'reject-unimplemented')
        self.assertEqual(self.doc['backend_expectations']['forge'], 'reject-unimplemented')
        self.assertEqual(len(self.doc['normalization']), 1)

    def test_golden_symbols(self):
        cases = self.doc['accept']
        self.assertEqual({case['id'] for case in cases},
                         {'color', 'mode', 'static-color', 'other-owner', 'unicode-owner'})
        self.assertEqual(len(cases), 5)
        for case in cases:
            with self.subTest(case=case['id']):
                self.assertEqual(link(case), case['symbol'])
        self.assertEqual(len(set(x['symbol'] for x in cases)), len(cases))

    def test_adversarial_schema_values_reject_without_implicit_python_errors(self):
        base = next(c for c in self.doc['accept'] if c['id'] == 'color')
        malformed = [None, [], 'string', {},
                     {**base, 'owner': None}, {**base, 'domain': []},
                     {**base, 'name': None}, {**base, 'positions': None},
                     {**base, 'positions': 'string'},
                     {**base, 'positions': [None]},
                     {**base, 'positions': [{}]},
                     {**base, 'positions': [{'kind': 'ENUM'}]},
                     {**base, 'positions': [{'kind': 'ENUM', 'id': []}]},
                     {**base, 'positions': [{'kind': 'PRIMITIVE', 'id': []}]},
                     {**base, 'positions': [{'kind': [], 'id': 'int'}]},
                     {**base, 'positions': [{'kind': 'ENUM', 'id': 'root::Color', 'tag': 1}]},
                     {**base, 'positions': [{'kind': 'ENUM', 'id': 'root::Color'}] * 65}]
        for index, case in enumerate(malformed):
            with self.subTest(index=index):
                with self.assertRaises(ValueError):
                    link(case)

    def test_corpus_removal_and_duplicates_are_detected(self):
        positives = self.doc['accept']
        negatives = self.doc['reject']
        self.assertEqual(len(positives), len({x['id'] for x in positives}))
        self.assertEqual(len(negatives), len({x['id'] for x in negatives}))
        self.assertEqual(len(self.doc['normalization']), 1)
        self.assertEqual(self.doc['normalization'][0]['id'], 'factory-String-to-string')
        self.assertEqual(self.doc['normalization'][0]['layer'], 'trusted-compiler-signature-factory')
        self.assertEqual(self.doc['normalization'][0]['positions'][0]['id'], 'String')

    def test_malformed_compiler_factory_positions_rejected(self):
        base = self.doc['normalization'][0]
        for positions in (None, [], [None], [{}], [{'kind':'PRIMITIVE','id':[]}],
                          [{'kind':'PRIMITIVE'}]):
            with self.subTest(positions=repr(positions)):
                if positions == []:
                    # A zero-argument factory call is structurally legal.
                    continue
                with self.assertRaises(ValueError):
                    normalize_compiler_factory({**base, 'positions': positions})

    def test_factory_alias_canonicalization_is_not_raw_abi_admission(self):
        # Raw String in a constructed ABI record must not be silently
        # equated to an independently certified primitive type identity.
        for case in self.doc['normalization']:
            with self.subTest(case=case['id']):
                with self.assertRaises((ValueError, UnicodeError)):
                    link(case)
                canonical = normalize_compiler_factory(case)
                self.assertEqual(link(canonical), case['symbol'])

    def test_raw_abi_primitive_alias_is_rejected(self):
        for case in self.doc['reject']:
            if case['id'] == 'primitive-alias':
                with self.assertRaises(ValueError):
                    link(case)
                break
        else:
            self.fail('missing primitive-alias regression')

    def test_negative_abi_shapes(self):
        self.assertEqual({case['id'] for case in self.doc['reject']},
                         {'invalid-domain', 'owner-control', 'bad-surrogate',
                          'oversize-name', 'unqualified-enum', 'primitive-alias',
                          'forged-kind', 'arity-limit', 'blank-owner', 'blank-name'})
        self.assertEqual(len(self.doc['reject']), 10)
        for case in self.doc['reject']:
            with self.subTest(case=case['id']):
                with self.assertRaises((ValueError, UnicodeError)):
                    link(case)


if __name__ == '__main__':
    unittest.main()
