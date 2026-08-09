@echo off
title BioMed Hub - Python Server
cd /d "%~dp0"
echo Starting BioMed Hub (Python) on http://localhost:5000
echo Admin: http://localhost:5000/admin.html
py server.py
pause