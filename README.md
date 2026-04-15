# FedGuard Windows Resource Monitor (JScript + Batch)

A lightweight, purely native Windows monitoring agent that tracks CPU, Memory, and Disk usage via WMI (Windows Management Instrumentation) and produces SQL `INSERT` statements to push telemetry to an Oracle Database.

**Key Feature:** Completely independent of PowerShell or external executable dependencies. It runs autonomously via native Windows Script Host.

## Core Features

1. **Telemetry Generation**: Averages CPU and RAM over a polling window. Reads active Disk partitions seamlessly. 
2. **True IPv4 Discovery**: Intelligently bypasses link-local (169.254.x.x) addresses and gracefully discovers the primary server IP.
3. **Autonomous Active Alerts**: Features an intelligent threshold limit switch. When hardware limitations are breached, it automatically fires advanced WMI queries to identify the highest consuming runaway process (like `chrome.exe` eating up CPU or Disk I/O) and isolates the violation into an independent `PROCESS_ALERTS` logging table.
4. **Resiliency**: Hardened with deep `try/catch` enclosures to ensure a single malfunctioning hardware WMI performance counter will not crash the telemetry logging for the whole agent.

## Components

- `gen.BAT`: Main entry point that primes Oracle log rotations and configures the environment.
- `run_all.bat`: The orchestrator that configures the agent thresholds and calls the JS payload.
- `resource_and_disk_sql.JS`: The core unified operational logic payload that queries WMI.

## Configuration Engine

You can deeply customize the agent behavior entirely without coding.

### 1. Alert Thresholds (`run_all.bat`)
At the top of `run_all.bat` you can specify alert triggers:
- `CPU_THRESHOLD=80`: Warn if averaged CPU % goes above 80 
- `MEM_THRESHOLD=85`: Warn if RAM working set usage pushes over 85%
- `DISK_THRESHOLD=90`: Warn if a logical drive's physical capacity is >90% documented
- `ENABLE_DISK_IO_ALERT=1`: Active process Disk I/O tracking toggle.

### 2. SQL Table Schemas (`resource_and_disk_sql.JS`)
At the immediate top of the JS file itself contains a SQL Configuration module allowing you to change Oracle Table bindings.

```javascript
// 1. Disk Usage Table
var TBL_DISK = "disk_usage";
var COL_DISK = "timestamp, ip_address, mount_point, total_size_gb, free_gb, used_gb, used_percent";

// 2. System Resource Table (CPU/Memory)
var TBL_SYS  = "monitor.system_resource";
var COL_SYS  = "timestamp, ip_address, cpu, memory";

// 3. Process Alerts Table (High Usage tracking)
var TBL_ALRT = "PROCESS_ALERTS";
var COL_ALRT = "timestamp, ip_address, alert_type, process_name, metric_value";
```

## Oracle Dependencies

The Oracle DB must have the `PROCESS_ALERTS` table instantiated to receive the advanced process metrics:
```sql
CREATE TABLE PROCESS_ALERTS (
   timestamp DATE,
   ip_address VARCHAR(45),
   alert_type VARCHAR(50), 
   process_name VARCHAR(255),
   metric_value VARCHAR(50)
);
```

## Usage

1. Modify configurations in `run_all.bat`. 
2. Double-click or execute `gen.BAT`.
3. Agent outputs are securely flushed and safely appended in `system_resource_disk.sql`.
