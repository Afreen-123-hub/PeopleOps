    1q# API Integration

The dashboard now uses live Worklogix and Teams APIs. Local Biometrics, GreytHR, Teams, and Worklogix input files are no longer part of the project flow.

## Credentials

Credentials are read from the `.env` file in the parent `May_Month_datas` folder.

## Generate Dashboard Data

Run:

```powershell
python .\scripts\generate_peopleops_data.py
```

The dashboard reads:

```text
data/peopleops-data.json
```

## Active Systems

- Worklogix employees, projects, tasks, and daily updates
- Biometrics presence report (`/api/v1/users/employee_presence_report`) — office hours and biometric days
- Teams/Microsoft Graph presence

## Optional Future Systems

GreytHR should be added back only as an API connector, not as a local uploaded spreadsheet input.
