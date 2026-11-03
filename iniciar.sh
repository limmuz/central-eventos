#!/usr/bin/env bash
# Central de Engenharia (demo) - instala na primeira vez e sobe o site em http://localhost:8050
set -e
cd "$(dirname "$0")"
[ -d .venv ] || { python3 -m venv .venv && .venv/bin/pip install -r requirements.txt; }
[ -f data/relatorio.db ] || .venv/bin/python seed_demo.py
.venv/bin/python servidor.py
