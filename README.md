# PeopleOPS Intelligence

An employee performance intelligence dashboard using live API integrations for:

- Worklogix users, projects, tasks, and work activity
- Microsoft Teams presence through Microsoft Graph

## Run

From this folder:

```powershell
python .\backend\server.py
```

Open:

```text
http://localhost:8000
```

The backend API is available at:

```text
http://localhost:8000/api/health
http://localhost:8000/api/data
http://localhost:8000/api/employees
http://localhost:8000/api/teams
http://localhost:8000/api/projects
http://localhost:8000/api/leave-types?month=2026-08
```

`/api/leave-types` powers the "Type of leaves taken" card on the Attendance page: GreytHR leave codes (CL, SL, ...) per person per day for one month, cached in `data/leave/YYYY-MM.json`. The daily refresh keeps the previous and current month saved; other months are fetched on first click. To save a month by hand: `python .\scripts\refresh_leave_types.py --month 2026-08`.

## Regenerate Data

When API data changes, rerun:

```powershell
python .\scripts\generate_peopleops_data.py
```

The dashboard reads:

```text
data/peopleops-data.json
```

You can also regenerate data through the backend:

```powershell
Invoke-WebRequest -Method POST http://localhost:8000/api/regenerate
```

## Role Test Logins

To check what each role sees, set `PEOPLEOPS_TEST_PASSWORD` in `.env` (or on Render) and sign in on the normal login page with a username from `data/test-accounts.json` (e.g. `vijay`, `christy`, `neaven`, `senthil`) and that password. Each test login gets the same role and scope that person would get through Microsoft SSO. Leave the variable unset to turn test logins off.

## Demo Login

For demos, sign in with username `demo` and the password in `PEOPLEOPS_DEMO_PASSWORD` (`.env` or Render). That session sees only the fake dataset in `data/demo/`: every name, id, email, project, meeting and link is made up, and scores are shifted. Refresh buttons, live Teams/GreytHR calls and MTM are off for it. Leave the variable unset to turn the demo login off.

Role demo logins use the same password and act as the fake copy of a real person, with that person's role and team: `demo-ceo`, `demo-md`, `demo-centerhead`, `demo-peoplemanager`, `demo-marketing`, `demo-bdm`. The list is `DEMO_ROLE_ACCOUNTS` in `scripts/generate_demo_data.py`; rerun the script after changing it.

To rebuild the demo data after the real data changes:

```powershell
python .\scripts\generate_demo_data.py
```

It refuses to write anything if it finds a real name, id, email, login or company/client word in the output.

## Backend

The backend is dependency-free and uses Python standard library only. No `pip install` is required.

## API Data

Credentials are read from the `.env` file in the parent `May_Month_datas` folder.

Generate data from live Worklogix and Teams APIs:

```powershell
python .\scripts\generate_peopleops_data.py
```

## KPI Model

The KPI is a weighted score:

- 45% Worklogix delivery
- 20% attendance reliability, currently neutral until an attendance API is added
- 15% Microsoft Teams collaboration activity
- 10% Worklogix workload volume
- 10% completion quality

If a Worklogix final score is unavailable, the script derives the delivery signal from work completion, approval rate, and workload volume.

## Data Shape

The dashboard reads one normalized file:

- `employees[]`
- `projects[]`
- `overview`
- `meta.sourceFiles`
- `meta.weights`

Biometrics and GreytHR file inputs have been removed. Add them back only through API connectors if needed later.
