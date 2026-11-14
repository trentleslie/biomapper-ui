# Recording pins: two_cohort

- biomapper version: 1.9.0
- recorded (UTC): 2026-11-14T04:42:42Z
- command (from `artifacts/python-api`): `python scripts/record_harmonize_run.py two_cohort`
- biomapper-ui git SHA: 659b74cf8ba6a1809d3b119739df9787a543f5a1 (working tree had uncommitted changes)

The report's `pins` block:

```json
{
  "api": {
    "base_url": "https://biomapper.expertintheloop.io/api/v1",
    "engine_release": "unavailable",
    "error": null,
    "self_reported_version": "0.1.0",
    "self_reported_version_label": "self-reported, known stale",
    "status": "healthy"
  },
  "biomapper_version": "1.9.0",
  "kestrel": {
    "error": null,
    "kestrel_version": "0.5.0",
    "kg_build": {
      "biolink_version": "4.2.5",
      "build_duration_minutes": 136.2,
      "build_timestamp": "2026-09-25T00:34:42.623612+00:00",
      "edge_count": null,
      "git_commit": "3dd08a5b7b17e320ceb0c0091e09b781d4d90242",
      "kg_label": null,
      "kg_version": "2.3.0",
      "kraken_package_version": "2.2.0",
      "node_count": null,
      "source_versions": {
        "babel": "2026jul22",
        "bio-age": "2019",
        "bio-bmi": "2023",
        "cdes": "accessed_2026-07-29",
        "ctkg": "4.1.7",
        "dakg": "0.5.7",
        "kg2": "2.10.2",
        "lipidmaps": "accessed_2026-08-07",
        "loinc": "2.82",
        "long-covid": "received_2026-09-17",
        "microbiome-kg": "2.1.0",
        "multiomics-kg": "2.1.0",
        "ncbigene": "accessed_2026-08-31",
        "pgs-catalog": "2026-07-29",
        "refmet": "accessed_2026-08-07",
        "robokop": "june2025",
        "translator-kg-open": "2026_07_19",
        "umls": "2025AA"
      },
      "sources": [
        "babel",
        "bio-age",
        "bio-bmi",
        "cdes",
        "ctkg",
        "dakg",
        "kg2",
        "lipidmaps",
        "loinc",
        "long-covid",
        "microbiome-kg",
        "multiomics-kg",
        "ncbigene",
        "pgs-catalog",
        "refmet",
        "robokop",
        "translator-kg-open",
        "umls"
      ],
      "steps_run": {
        "harmonize": false,
        "integrate": true,
        "postprocess": false
      }
    },
    "label": "Kestrel's own /health; the graph the API used is assumed, not verified, to be this build",
    "url": "https://kestrel.krakenkg.com/api"
  },
  "mapper": "GatedJobMapper",
  "mapper_pins": null,
  "timestamp_utc": "2026-11-14T04:42:43.176543+00:00"
}
```
