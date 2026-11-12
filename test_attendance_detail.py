import unittest
from datetime import date

from services.attendance_detail import build_employee_detail


class AttendanceDetailTests(unittest.TestCase):
    def setUp(self):
        self.employee = {
            "id": "CWINE001",
            "name": "Christina Arulraj",
            "sourceKeys": {"greythr": "CWINE001"},
            "attendance": {"officeLocation": "Codework-Beta"},
        }
        self.payload = {
            "month": "2026-10",
            "fetchedAt": "2026-10-20T04:00:00+00:00",
            "people": [{"id": "3", "no": "CWINE001", "name": "Christina Arulraj"}],
            "days": {
                "2026-10-15": {"3": {"s": "P", "bi": "09:18", "bo": "18:11", "door": "Codework-Beta"}},
                "2026-10-16": {"3": {"s": "A"}},
                "2026-10-17": {"3": {"s": "A"}},
                "2026-10-18": {"3": {"s": "A"}},
                "2026-10-19": {"3": {"s": "A"}},
            },
        }

    def test_weekend_rows_are_not_returned(self):
        result = build_employee_detail(self.payload, self.employee)
        self.assertEqual([r["date"] for r in result["rows"]], ["2026-10-19", "2026-10-16", "2026-10-15"])
        self.assertEqual([r["status"] for r in result["rows"]], ["Absent", "Absent", "Present"])

    def test_times_location_and_duration_use_existing_swipe_cache(self):
        row = build_employee_detail(self.payload, self.employee)["rows"][-1]
        self.assertEqual((row["login"], row["logout"]), ("09:18", "18:11"))
        self.assertEqual(row["workMode"], "Beta Office")
        self.assertEqual(row["workedMinutes"], 533)

    def test_remote_swipe_is_work_from_home(self):
        self.payload["days"] = {"2026-10-20": {"3": {"s": "P", "wi": "10:41", "wo": "18:02"}}}
        row = build_employee_detail(self.payload, self.employee)["rows"][0]
        self.assertEqual(row["workMode"], "Work from Home")
        self.assertEqual(row["workedMinutes"], 441)

    def test_weekday_marked_off_is_not_returned(self):
        self.payload["days"] = {"2026-10-20": {"3": {"s": "OFF"}}}
        self.assertEqual(build_employee_detail(self.payload, self.employee)["rows"], [])

    def test_weekday_without_employee_record_is_visible(self):
        self.payload["days"] = {"2026-10-20": {"other-person": {"s": "P"}}}
        row = build_employee_detail(self.payload, self.employee)["rows"][0]
        self.assertEqual(row["status"], "No record")
        self.assertEqual((row["login"], row["logout"], row["workMode"]), ("", "", "—"))

    def test_today_distinguishes_checked_in_from_not_checked_in(self):
        self.payload["days"] = {
            "2026-10-20": {"3": {"bi": "09:12", "door": "Codework-Beta"}},
        }
        row = build_employee_detail(self.payload, self.employee, today=date(2026, 10, 20))["rows"][0]
        self.assertEqual(row["status"], "Checked in")
        self.payload["days"]["2026-10-20"] = {"other-person": {"s": "P"}}
        row = build_employee_detail(self.payload, self.employee, today=date(2026, 10, 20))["rows"][0]
        self.assertEqual(row["status"], "Not checked in")


if __name__ == "__main__":
    unittest.main()
