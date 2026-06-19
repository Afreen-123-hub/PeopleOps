from __future__ import annotations

import sys
from pathlib import Path

import json

PROJECT_ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(PROJECT_ROOT))

from services.teams_api_client import get_presences_by_user_id
from services.teams_auth import get_token
from services.teams_transformer import teams_presence_dataframe_from_payload


SAMPLE_USER_IDS = [
    "c0090a53-3c2b-4785-8d27-d229d20c04e7",
]


def main():
    try:
        token = get_token()
        if not token:
            raise RuntimeError("access_token was not returned")
        print("Teams token fetch success")

        response = get_presences_by_user_id(SAMPLE_USER_IDS)
        print("Teams presence API fetch success")
        print(f"User count requested: {len(SAMPLE_USER_IDS)}")
        print(f"Response type: {type(response).__name__}")
        print(f"First sample record: {json.dumps(response, ensure_ascii=False)[:1000]}")

        frame = teams_presence_dataframe_from_payload(response)
        print("Teams transformer success")
        print(f"Transformed row count: {len(frame)}")
        print(f"Transformed columns: {list(frame.columns)}")
        transformed_rows = frame.to_dict("records")
        print(
            f"First transformed record: {transformed_rows[0] if transformed_rows else {}}"
        )
    except Exception as exc:
        raise SystemExit(f"FAIL Teams API test: {exc}") from exc


if __name__ == "__main__":
    main()
