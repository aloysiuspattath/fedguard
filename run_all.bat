@echo off
setlocal EnableExtensions EnableDelayedExpansion

REM ============================================================
REM Collector: Unified resource_and_disk_sql.JS
REM Writes INSERTs into system_resource_disk.sql
REM GUARANTEES: WHENEVER SQLERROR, COMMIT; and EXIT are appended at the end
REM ============================================================

REM ===== 1) Config =====
set "PURGE=1"
set "SAMPLE_COUNT=5"
set "CPU_THRESHOLD=80"
set "MEM_THRESHOLD=85"
set "DISK_THRESHOLD=90"


REM ===== 2) Paths =====
set "BASEDIR=%~dp0"
set "OUTFILE=%BASEDIR%system_resource_disk.sql"
set "JS_COLLECTOR=%BASEDIR%resource_and_disk_sql.JS"

REM ===== 3) Prepare SQL output file =====
if "%PURGE%"=="1" (
  if exist "%OUTFILE%" del /f /q "%OUTFILE%"
  type nul > "%OUTFILE%"
) else (
  if not exist "%OUTFILE%" type nul > "%OUTFILE%"
)

REM ------------------------------------------------------------
REM A) DATA INSERTs via unified JScript
REM ------------------------------------------------------------
set "JS_OK=1"
if not exist "%JS_COLLECTOR%" (
  set "JS_OK=0"
  echo [ERROR] Missing JS Collector: %JS_COLLECTOR%
) else (
  REM Arguments: [sampleCount] [driveTypeFilter] [threshCPU] [threshMem] [threshDisk]
  cscript //nologo "%JS_COLLECTOR%" "!SAMPLE_COUNT!" "3" "!CPU_THRESHOLD!" "!MEM_THRESHOLD!" "!DISK_THRESHOLD!" >> "%OUTFILE%" 2>nul
  if errorlevel 1 set "JS_OK=0"
)

REM ------------------------------------------------------------
REM B) ALWAYS append SQL*Plus guards and COMMIT/EXIT at the end
REM ------------------------------------------------------------
>> "%OUTFILE%" echo SET PAGESIZE 5000
>> "%OUTFILE%" echo SET LINESIZE 500
>> "%OUTFILE%" echo SET FEEDBACK ON
>> "%OUTFILE%" echo SET ECHO ON
>> "%OUTFILE%" echo WHENEVER SQLERROR EXIT FAILURE;
>> "%OUTFILE%" echo COMMIT;
>> "%OUTFILE%" echo EXIT;

REM ------------------------------------------------------------
REM C) Status to console
REM ------------------------------------------------------------
echo Completed. Collector OK=!JS_OK! (CPU_Thresh=!CPU_THRESHOLD!%%, Mem_Thresh=!MEM_THRESHOLD!%%, Disk_Thresh=!DISK_THRESHOLD!%%)

endlocal
exit /b 0
