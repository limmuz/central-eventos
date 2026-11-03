@echo off
REM Central de Engenharia (demo) - instala na primeira vez e sobe o site em http://localhost:8050
cd /d "%~dp0"
if not exist .venv (
  echo Criando ambiente Python...
  python -m venv .venv || (echo Instale o Python 3.10+ marcando "Add Python to PATH". & pause & exit /b 1)
  .venv\Scripts\pip install -r requirements.txt
)
if not exist data\relatorio.db (
  echo Criando banco com dados de demonstracao...
  .venv\Scripts\python seed_demo.py
)
start "" http://localhost:8050
.venv\Scripts\python servidor.py
