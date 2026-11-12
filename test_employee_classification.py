import unittest

from scripts.generate_peopleops_data import greythr_reporting_subtree_employee_nos


class GreytHRReportingSubtreeTests(unittest.TestCase):
    def test_includes_root_direct_and_nested_reports(self):
        rows = [
            {"id": 1, "pid": None, "employeeNo": "CWINE123", "resigned": False},
            {"id": 2, "pid": 1, "employeeNo": "CWINI255", "resigned": False},
            {"id": 3, "pid": 2, "employeeNo": "CWINE999", "resigned": False},
            {"id": 4, "pid": None, "employeeNo": "OTHER", "resigned": False},
        ]

        self.assertEqual(
            greythr_reporting_subtree_employee_nos(rows, "CWINE123"),
            {"CWINE123", "CWINI255", "CWINE999"},
        )

    def test_excludes_resigned_descendants(self):
        rows = [
            {"id": 1, "pid": None, "employeeNo": "CWINE123", "resigned": False},
            {"id": 2, "pid": 1, "employeeNo": "OLD", "resigned": True},
            {"id": 3, "pid": 2, "employeeNo": "CHILD-OF-OLD", "resigned": False},
        ]

        self.assertEqual(
            greythr_reporting_subtree_employee_nos(rows, "CWINE123"),
            {"CWINE123"},
        )


if __name__ == "__main__":
    unittest.main()
