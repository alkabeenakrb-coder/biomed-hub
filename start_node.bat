@echo off
title BioMed Hub - Node Server
cd /d "%~dp0"
echo Starting BioMed Hub (Node.js) on http://localhost:8080
echo Admin: http://localhost:8080/admin.html
node server.js
pause