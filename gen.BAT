@echo off
setlocal EnableExtensions EnableDelayedExpansion

rem ========== Oracle network config ==========



set PATH=C:\fedguard_agent\instantclient;%PATH%
set TNS_ADMIN=C:\fedguard_agent\instantclient\network\admin

REM --- Base paths
set "BASEDIR=%~dp0"

REM --- Build RUN_ID = yyyyMMdd_HHmmss
for /f "tokens=2 delims==" %%i in ('wmic os get LocalDateTime /value ^| find "="') do set LDT=%%i
set "RUN_ID=%LDT:~0,4%%LDT:~4,2%%LDT:~6,2%_%LDT:~8,2%%LDT:~10,2%%LDT:~12,2%"
set "RUN_DIR=%BASEDIR%logs\%RUN_ID%"
if not exist "%RUN_DIR%" mkdir "%RUN_DIR%"

REM --- File targets (unique per run)
set "MAIN_LOG=%RUN_DIR%\main_%RUN_ID%.log"
set "RUNALL_STDOUT=%RUN_DIR%\run_all_stdout.log"
set "RUNALL_STDERR=%RUN_DIR%\run_all_stderr.log"
set "SQLPLUS_LOG=%RUN_DIR%\sqlplus_%RUN_ID%.log"
set "SQLFILE=%BASEDIR%system_resource_disk.sql"
set "RUNALL=%BASEDIR%run_all.bat"

call :log "=== FedGuard run %RUN_ID% started ==="
call :log "BASEDIR=%BASEDIR%"

REM --- Sanity checks
if not exist "%RUNALL%" ( call :log "[ERROR] Missing %RUNALL%"; exit /b 1 )
where sqlplus >nul 2>&1 || ( call :log "[ERROR] sqlplus not in PATH"; exit /b 1 )

REM === Cleanup: Keep ONLY last 3 run folders ===
set "LOGROOT=%BASEDIR%logs"

REM Collect run folders sorted by date/time (descending)
set i=0
for /f "delims=" %%D in ('dir "%LOGROOT%" /ad /b /o-d') do (
    set /a i+=1
    if !i! GTR 3 (
        echo Deleting old run folder: %%D
        rmdir /s /q "%LOGROOT%\%%D"
    )
)


REM --- 1) Generate SQL via run_all.bat  (to its own logs)
call :log "[INFO] Generating SQL via run_all.bat ..."
call "%RUNALL%" 1>>"%RUNALL_STDOUT%" 2>>"%RUNALL_STDERR%"
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" (
  call :log "[ERROR] run_all.bat failed rc=%RC%. Check %RUNALL_STDERR%"
  exit /b %RC%
)

REM --- 2) Validate SQL file
if not exist "%SQLFILE%" ( call :log "[ERROR] No SQL generated at %SQLFILE%"; exit /b 2 )
for %%I in ("%SQLFILE%") do set "SQLSIZE=%%~zI"
if "%SQLSIZE%"=="0" ( call :log "[ERROR] SQL is empty at %SQLFILE%"; exit /b 3 )

REM --- 3) Execute SQL via sqlplus (to its own log, not main_log)
call :log "[INFO] Executing SQL via sqlplus /@FEDGUARD ..."
sqlplus -L -S /@FEDGUARD @"%SQLFILE%" 1>>"%SQLPLUS_LOG%" 2>&1
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" (
  call :log "[ERROR] sqlplus failed rc=%RC%. See %SQLPLUS_LOG%"
  exit /b %RC%
)

call :log "[INFO] SQL executed successfully."
call :log "=== Completed successfully ==="
echo Completed successfully.
exit /b 0

:log
>>"%MAIN_LOG%" echo [%date% %time%] %~1
exit /b 0


