// resource_and_disk_sql.js — Emit disk_usage INSERTs + one SYSTEM_RESOURCE INSERT + optional PROCESS_ALERTS
// argv[0] = sampleCount for CPU/Memory (optional, default 10)
// argv[1] = driveTypeFilter: "3" (fixed), "2" (removable), "23" (both) [optional]
// argv[3] = enable disk IO alert (optional, default 1)

// =========================================================================
// SQL CONFIGURATION - Edit these to match your Oracle Database schema
// =========================================================================

// 1. Disk Usage Table
var TBL_DISK = "disk_usage";
var COL_DISK = "timestamp, ip_address, mount_point, total_size_gb, free_gb, used_gb, used_percent";

// 2. System Resource Table (CPU/Memory)
var TBL_SYS  = "monitor.system_resource";
var COL_SYS  = "timestamp, ip_address, cpu, memory";

// 3. Process Alerts Table (High Usage tracking)
var TBL_ALRT = "PROCESS_ALERTS";
var COL_ALRT = "timestamp, ip_address, alert_type, process_name, metric_value";

// =========================================================================

(function(){
  var args = WScript.Arguments;
  var sampleCount = args.length >= 1 ? parseInt(args(0), 10) : 10;
  if (!isFinite(sampleCount) || sampleCount <= 0) sampleCount = 10;
  var filt = args.length >= 2 ? String(args(1)) : "3"; 
  var threshCpu = args.length >= 3 ? parseFloat(args(2)) : 80.0;
  if (!isFinite(threshCpu)) threshCpu = 80.0;

  var threshMem = args.length >= 4 ? parseFloat(args(3)) : 80.0;
  if (!isFinite(threshMem)) threshMem = 80.0;

  var threshDisk = args.length >= 5 ? parseFloat(args(4)) : 80.0;
  if (!isFinite(threshDisk)) threshDisk = 80.0;

  var enableDiskIO = args.length >= 6 ? String(args(5)) : "1";

  function round1(x){ return Math.round(x * 10) / 10; }
  function pad(n) { return n < 10 ? "0" + n : String(n); }

  function getTimestamp() {
      var d = new Date();
      return pad(d.getDate()) + "-" + pad(d.getMonth() + 1) + "-" + d.getFullYear() + " " + 
             pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds());
  }

  var svc;
  try {
      svc = GetObject("winmgmts:\\\\.\\root\\cimv2");
  } catch (e) {
      WScript.Echo("-- ERROR: Could not connect to WMI root\\cimv2. " + e.message);
      WScript.Quit(1);
  }

  function getLocalIP(svc) {
      try {
          var adapters = svc.ExecQuery("SELECT IPAddress, DefaultIPGateway FROM Win32_NetworkAdapterConfiguration WHERE IPEnabled = True");
          var e = new Enumerator(adapters);
          var fallbackIP = null;
          for (; !e.atEnd(); e.moveNext()) {
              var adapter = e.item();
              var ips = adapter.IPAddress;
              var gw = adapter.DefaultIPGateway;
              if (ips != null) {
                  var ipArray = new VBArray(ips).toArray();
                  for (var i = 0; i < ipArray.length; i++) {
                      var ip = String(ipArray[i]);
                      if (ip.indexOf(".") > -1 && ip.indexOf("169.254.") !== 0) {
                          if (gw != null) return ip;
                          if (fallbackIP === null) fallbackIP = ip;
                      }
                  }
              }
          }
          if (fallbackIP !== null) return fallbackIP;
      } catch(e) { /* ignore */ }
      return "0.0.0.0";
  }

  var logicalProcs = 1;
  try {
      var cs = svc.ExecQuery("SELECT NumberOfLogicalProcessors FROM Win32_ComputerSystem");
      var eCs = new Enumerator(cs);
      if (!eCs.atEnd()) {
          logicalProcs = Number(eCs.item().NumberOfLogicalProcessors) || 1;
      }
  } catch(e) {}

  var totalMemBytes = 1;
  try {
      var osSet = svc.ExecQuery("SELECT TotalVisibleMemorySize FROM Win32_OperatingSystem");
      var eOs = new Enumerator(osSet);
      if (!eOs.atEnd()) {
          totalMemBytes = Number(eOs.item().TotalVisibleMemorySize) * 1024 || 1;
      }
  } catch(e) {}

  // --- Fetch Highest Consumer Processes ---
  function getTopProcess(svc, type, limit) {
      if (!limit) limit = 1; // Default to top 1
      try {
          var perf = svc.ExecQuery("SELECT Name, PercentProcessorTime, WorkingSetPrivate, IODataBytesPersec FROM Win32_PerfFormattedData_PerfProc_Process");
          var eProc = new Enumerator(perf);
          var agg = {};

          for (; !eProc.atEnd(); eProc.moveNext()) {
              var p = eProc.item();
              var rawName = String(p.Name || "");
              if (rawName === "_Total" || rawName === "Idle") continue;

              // Group instances like "brave#1" -> "brave" to match Task Manager
              var name = rawName;
              var hashIdx = name.indexOf("#");
              if (hashIdx > 0) name = name.substring(0, hashIdx);

              var rawVal = 0;
              if (type === "CPU") rawVal = Number(p.PercentProcessorTime);
              else if (type === "MEMORY") rawVal = Number(p.WorkingSetPrivate);
              else if (type === "DISK") rawVal = Number(p.IODataBytesPersec);

              if (isFinite(rawVal) && rawVal > 0) {
                  if (!agg[name]) agg[name] = 0;
                  agg[name] += rawVal;
              }
          }
          
          var procs = [];
          for (var key in agg) {
              var rawTotal = agg[key];
              var displayVal = 0;
              var formattedVal = "";
              
              if (type === "CPU") {
                  displayVal = Math.round(rawTotal / logicalProcs);
                  if (displayVal <= 0) continue;
                  formattedVal = displayVal + "%";
              } else if (type === "MEMORY") {
                  displayVal = Math.round((rawTotal / totalMemBytes) * 1000) / 10;
                  formattedVal = displayVal + "%";
              } else if (type === "DISK") {
                  displayVal = rawTotal;
                  formattedVal = Math.round(rawTotal / 1024) + " KB/s I/O";
              }
              
              if (displayVal > 0) {
                  procs.push({ name: key, value: formattedVal, rawObjVal: displayVal });
              }
          }
          
          // Sort descending
          procs.sort(function(a, b) { return b.rawObjVal - a.rawObjVal; });
          
          var results = [];
          for (var i = 0; i < Math.min(limit, procs.length); i++) {
              results.push({ name: procs[i].name, value: procs[i].value });
          }
          return results;
      } catch(e) {}
      return [];
  }

  var ts = getTimestamp();
  var GB = 1073741824.0; 

  var ip = getLocalIP(svc);

  // --- Disk INSERTs ---
  var whereClause = "DriveType=3";
  if (filt === "23") whereClause = "DriveType=2 OR DriveType=3";
  else if (filt === "2") whereClause = "DriveType=2";

  try {
      var query = "SELECT DeviceID, Size, FreeSpace FROM Win32_LogicalDisk WHERE " + whereClause;
      var disks = svc.ExecQuery(query);
      var eDisk = new Enumerator(disks);
      for (; !eDisk.atEnd(); eDisk.moveNext()) {
        var d = eDisk.item();
        var dev = d.DeviceID, size = d.Size, free = d.FreeSpace;
        if (dev == null || size == null || free == null) continue;
        var sizeN = Number(size), freeN = Number(free);
        if (!isFinite(sizeN) || !isFinite(freeN)) continue;
        
        var totalGB = round1(sizeN / GB);
        var freeGB = round1(freeN / GB);
        var usedGB = round1(totalGB - freeGB);
        var usedPct = totalGB > 0 ? Math.round((usedGB * 100.0) / totalGB) : 0;
        
        var sqlDisk =
          "INSERT INTO " + TBL_DISK + " (" + COL_DISK + ") VALUES " +
          "(TO_DATE('" + ts + "','DD-MM-YYYY HH24:MI:SS'), '" + ip + "', '" + dev + "', " +
          totalGB + ", " + freeGB + ", " + usedGB + ", " + usedPct + ");";
        WScript.Echo(sqlDisk);

        // DISK ALERT
        if (usedPct >= threshDisk && enableDiskIO === "1") {
            var topProcs = getTopProcess(svc, "DISK", 1);
            for (var k = 0; k < topProcs.length; k++) {
                var topP = topProcs[k];
                var sqlAlert = "INSERT INTO " + TBL_ALRT + " (" + COL_ALRT + ") VALUES " +
                  "(TO_DATE('" + ts + "','DD-MM-YYYY HH24:MI:SS'), '" + ip + "', 'GLOBAL_TOP_DISK_IO', '" + topP.name + "', '" + topP.value + "');";
                WScript.Echo(sqlAlert);
            }
        }
      }
  } catch (e) {
      WScript.Echo("-- ERROR querying disk usage: " + e.message);
  }

  // --- Memory (% used) ---
  function getMemUsedPct() {
    try {
        var osSet = svc.ExecQuery("SELECT TotalVisibleMemorySize, FreePhysicalMemory FROM Win32_OperatingSystem");
        var eOS = new Enumerator(osSet);
        var totalKB = 0.0, freeKB = 0.0;
        for (; !eOS.atEnd(); eOS.moveNext()) {
          var os = eOS.item();
          totalKB = Number(os.TotalVisibleMemorySize);
          freeKB  = Number(os.FreePhysicalMemory);
          break;
        }
        if (isFinite(totalKB) && totalKB > 0 && isFinite(freeKB) && freeKB >= 0) {
          return ((totalKB - freeKB) * 100.0) / totalKB;
        }
        return 0.0;
    } catch(e) { return 0.0; }
  }

  // --- CPU (% total) ---
  function getCpuTotalPct() {
    try {
        var cpuPct = 0.0;
        var perf = svc.ExecQuery("SELECT Name, PercentProcessorTime FROM Win32_PerfFormattedData_PerfOS_Processor");
        var eCPU = new Enumerator(perf);
        var totalFound = false, sum = 0.0, count = 0;
        for (; !eCPU.atEnd(); eCPU.moveNext()) {
          var p = eCPU.item();
          var name = String(p.Name || "");
          var val = Number(p.PercentProcessorTime);
          if (!isFinite(val)) continue;
          if (name === "_Total") { cpuPct = val; totalFound = true; break; } 
          else { sum += val; count += 1; }
        }
        if (!totalFound && count > 0) cpuPct = sum / count;
        return cpuPct;
    } catch(e) { return 0.0; }
  }

  var sumCpu = 0.0, sumMem = 0.0;
  for (var i = 0; i < sampleCount; i++) {
    sumCpu += getCpuTotalPct();
    sumMem += getMemUsedPct();
    if (i < sampleCount - 1) WScript.Sleep(1000);
  }

  var cpuAvg = round1(sumCpu / sampleCount);
  var memAvg = round1(sumMem / sampleCount);
  
  if (!isFinite(cpuAvg)) cpuAvg = 0.0;
  if (!isFinite(memAvg)) memAvg = 0.0;
  if (cpuAvg < 0) cpuAvg = 0.0;
  if (cpuAvg > 100) cpuAvg = 100.0;
  if (memAvg < 0) memAvg = 0.0;
  if (memAvg > 100) memAvg = 100.0;

  var sqlRes =
    "INSERT INTO " + TBL_SYS + " (" + COL_SYS + ") VALUES " +
    "(TO_DATE('" + ts + "','DD-MM-YYYY HH24:MI:SS'), '" + ip + "', " + cpuAvg + ", " + memAvg + ");";
  WScript.Echo(sqlRes);

  // SYSTEM ALERTS
  if (cpuAvg >= threshCpu) {
      var topCpuProcs = getTopProcess(svc, "CPU", 1);
      for (var k = 0; k < topCpuProcs.length; k++) {
          var topC = topCpuProcs[k];
          var sqlAlertC = "INSERT INTO " + TBL_ALRT + " (" + COL_ALRT + ") VALUES " +
            "(TO_DATE('" + ts + "','DD-MM-YYYY HH24:MI:SS'), '" + ip + "', 'CPU', '" + topC.name + "', '" + topC.value + "');";
          WScript.Echo(sqlAlertC);
      }
  }

  if (memAvg >= threshMem) {
      var topMemProcs = getTopProcess(svc, "MEMORY", 1);
      for (var k = 0; k < topMemProcs.length; k++) {
          var topM = topMemProcs[k];
          var sqlAlertM = "INSERT INTO " + TBL_ALRT + " (" + COL_ALRT + ") VALUES " +
            "(TO_DATE('" + ts + "','DD-MM-YYYY HH24:MI:SS'), '" + ip + "', 'MEMORY', '" + topM.name + "', '" + topM.value + "');";
          WScript.Echo(sqlAlertM);
      }
  }

})();
