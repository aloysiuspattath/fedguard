
# Windows Resource Collector (JScript + Batch)

This bundle produces SQL `INSERT` statements for:
- **Disk usage** per logical drive -> `disk_usage` table (GB values rounded to **1 decimal**)
- **System resource** (CPU %, Memory % used) -> `SYSTEM_RESOURCE` table (averaged over **N samples** and rounded to **1 decimal**)

All outputs are appended to `system_resource_disk.sql`.

## Files
- `usage_gb_sql.js` — emits `INSERT INTO disk_usage ...` per drive (1-decimal GB).
- `system_resource_sql.js` — emits one `INSERT INTO SYSTEM_RESOURCE ...` with **averaged** CPU and memory (%).
- `resource_and_disk_sql.js` — optional single JScript that outputs both disk and system inserts in one run.
- `run_all_bat_with_error_handling.txt` — batch wrapper to orchestrate and append all SQL lines.

## Sampling & Rounding
- **CPU/Memory averaging**: scripts sample values every second and average over `sampleCount` readings.
  - `system_resource_sql.js` arg3 = `sampleCount` (default **10**). Use `5` for quicker runs.
  - `resource_and_disk_sql.js` arg4 = `sampleCount` (default **10**).
- **Rounding**:
  - Disk sizes: total/free/used in GB rounded to **1 decimal**.
  - CPU/Memory percentages: averaged then rounded to **1 decimal**.

## Usage
1. Place all files in the same folder.
2. Run the batch wrapper:
   ```bat
   run_all_bat_with_error_handling.txt
   ```
   Set `SAMPLE_COUNT=5` at the top of the file if you want a faster 5-second average.

3. Run JScript directly (examples):
   ```bat
   cscript //nologo system_resource_sql.js "04-12-2025 10:34:40" "10.251.9.72" 10
   cscript //nologo usage_gb_sql.js "04-12-2025 10:34:40" "10.251.9.72" 3
   cscript //nologo resource_and_disk_sql.js "04-12-2025 10:34:40" "10.251.9.72" 3 10
   ```

## Output Example
```
INSERT INTO disk_usage (timestamp, ip_address, mount_point, total_size_gb, free_gb, used_gb, used_percent) VALUES (TO_DATE('04-12-2025 10:34:40','DD-MM-YYYY HH24:MI:SS'), '10.251.9.72', 'C:', 99.1, 20.4, 78.7, 79);
INSERT INTO SYSTEM_RESOURCE (timestamp, ip_address, cpu, memory) VALUES (TO_DATE('04-12-2025 10:34:40','DD-MM-YYYY HH24:MI:SS'), '10.251.9.72', 4.8, 42.1);
```

## Notes
- Uses WMI classes: `Win32_LogicalDisk`, `Win32_OperatingSystem`, `Win32_PerfFormattedData_PerfOS_Processor`.
- If performance counters are disabled, CPU might read 0; enable perf counters if needed.
