"""Source-free mathematical oracle for proposed case-refined overload relations.

Run: python3 -B -m unittest discover -s contracts/v2 -p 'test_enum_case_overlap_model.py' -v

This is NOT a guest compiler/JUnit/native-image test; it checks the abstract
pairwise relation against independently enumerated finite value domains.
"""
import itertools
import unittest

DOMAINS = {"root.Foo": ("A", "B", "C"), "root.Bar": ("X", "Y")}
PARAMS = [("fixed", "int", None), ("fixed", "string", None)]
for enum_id, names in DOMAINS.items():
    PARAMS.append(("enum", enum_id, None))
    PARAMS.extend(("case", enum_id, name) for name in names)


def algorithm(left, right):
    """Language-neutral translation of Java EnumCaseOverloadPolicy.relation."""
    left_subset = True
    right_subset = True
    disjoint = False
    for a, b in zip(left, right):
        if a[0] == "fixed" or b[0] == "fixed":
            if a != b:
                return "INVALID"
            continue
        if a[1] != b[1]:
            disjoint = True
            continue
        if a[0] == "enum" and b[0] == "case":
            left_subset = False
        elif a[0] == "case" and b[0] == "enum":
            right_subset = False
        elif a[0] == "case" and b[0] == "case" and a[2] != b[2]:
            disjoint = True
    if disjoint:
        return "DISJOINT"
    if left_subset and right_subset:
        return "EQUAL"
    if left_subset:
        return "LEFT_NARROWER"
    if right_subset:
        return "RIGHT_NARROWER"
    return "INVALID"


def denotation(signature):
    """Explicit finite set of tuples accepted by a signature."""
    positions = []
    for kind, enum_id, case in signature:
        if kind == "fixed":
            positions.append(((enum_id, None),))
        elif kind == "enum":
            positions.append(tuple((enum_id, c) for c in DOMAINS[enum_id]))
        else:
            positions.append(((enum_id, case),))
    return set(itertools.product(*positions))


def independent_oracle(left, right):
    # Distinct ordinary types must never be used for admission, even if
    # an enum position makes the candidates mathematically disjoint.
    if any((a[0] == "fixed" or b[0] == "fixed") and a != b
           for a, b in zip(left, right)):
        return "INVALID"
    left_values, right_values = denotation(left), denotation(right)
    if not left_values & right_values:
        return "DISJOINT"
    if left_values == right_values:
        return "EQUAL"
    if left_values < right_values:
        return "LEFT_NARROWER"
    if right_values < left_values:
        return "RIGHT_NARROWER"
    return "INVALID"


class EnumCaseOverlapModelTest(unittest.TestCase):
    def test_all_two_parameter_signature_pairs(self):
        signatures = tuple(itertools.product(PARAMS, repeat=2))
        self.assertEqual(81, len(signatures))
        for a in signatures:
            for b in signatures:
                with self.subTest(left=a, right=b):
                    self.assertEqual(independent_oracle(a, b), algorithm(a, b))

    def test_intersecting_crossed_specializations_rejected(self):
        left = (("case", "root.Foo", "A"), ("enum", "root.Bar", None))
        right = (("enum", "root.Foo", None), ("case", "root.Bar", "Y"))
        self.assertEqual("INVALID", algorithm(left, right))

    def test_parent_and_case_nested(self):
        a = (("case", "root.Foo", "A"),)
        whole = (("enum", "root.Foo", None),)
        self.assertEqual("LEFT_NARROWER", algorithm(a, whole))
        self.assertEqual("RIGHT_NARROWER", algorithm(whole, a))


if __name__ == "__main__":
    unittest.main()
