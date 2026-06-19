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
```

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
