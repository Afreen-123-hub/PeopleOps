import unittest
from collections import Counter

from services.work_location_store import attendance_from_payload, prefer_cached_attendance


class WorkLocationKpiBridgeTests(unittest.TestCase):
    def setUp(self):
        self.payload = {
            "v": 2,
            "month": "2026-11",
            "people": [{"id": "3", "no": "CWINE001", "name": "Christina Arulraj"}],
            "days": {
                "2026-11-02": {"3": {"s": "P", "bi": "09:12"}},
                "2026-11-03": {"3": {"s": "A"}},
                "2026-11-04": {"3": {"s": "P/CL"}},
                "2026-11-05": {"3": {"wi": "10:04"}},
                "2026-11-06": {"3": {"s": "H"}},
                "2026-11-07": {"3": {"s": "OFF"}},
            },
        }

    def test_cache_becomes_kpi_attendance_under_all_employee_aliases(self):
        counters, days = attendance_from_payload(self.payload, "2026-11-01", "2026-11-30")
        for alias in ("3", "CWINE001", "name:christinaarulraj"):
            self.assertIn(alias, counters)
            self.assertEqual(counters[alias]["P"], 1.5)
            self.assertEqual(counters[alias]["A"], 1)
            self.assertEqual(counters[alias]["Leave"], 0.5)
            self.assertEqual(counters[alias]["WFH"], 1)
            self.assertEqual(days[alias]["2026-11-04"], "P/Leave")

    def test_richer_cache_replaces_blank_muster_without_double_counting(self):
        cached, cached_days = attendance_from_payload(self.payload)
        primary = {"CWINE001": Counter({"Blank": 10, "OFF": 2})}
        primary_days = {"CWINE001": {"2026-11-01": "OFF"}}
        improved = prefer_cached_attendance(primary, primary_days, cached, cached_days)
        self.assertGreater(improved, 0)
        self.assertEqual(primary["CWINE001"]["P"], 1.5)
        self.assertNotIn("Blank", primary["CWINE001"])

    def test_off_only_cache_never_overwrites_real_live_attendance(self):
        primary = {"CWINE001": Counter({"P": 4})}
        primary_days = {"CWINE001": {"2026-11-02": "P"}}
        cached = {"CWINE001": Counter({"OFF": 5})}
        cached_days = {"CWINE001": {"2026-11-02": "OFF"}}
        self.assertEqual(prefer_cached_attendance(primary, primary_days, cached, cached_days), 0)
        self.assertEqual(primary["CWINE001"]["P"], 4)


if __name__ == "__main__":
    unittest.main()
