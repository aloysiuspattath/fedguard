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

// 3. Process Alerts Tables (High Usage tracking)
var TBL_CPU  = "MONITOR.CPU";
var TBL_MEM  = "MONITOR.MEMORY";
// Note: ID was requested, but database-side auto-increment sequences naturally dictate leaving ID omitted from INSERT values.
var COL_PROC = "TIMESTAMP, IP_ADDRESS, PID, CMD, PER";


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
          var perf = svc.ExecQuery("SELECT Name, IDProcess, PercentProcessorTime, WorkingSetPrivate FROM Win32_PerfFormattedData_PerfProc_Process");
          var eProc = new Enumerator(perf);
          var procs = [];

          for (; !eProc.atEnd(); eProc.moveNext()) {
              var p = eProc.item();
              var rawName = String(p.Name || "");
              
              // Ignore harmless internal OS or pseudo-processes
              if (rawName === "_Total" || rawName === "Idle" || rawName === "Memory Compression" || rawName === "System" || rawName === "Registry") continue;

              var pid = Number(p.IDProcess);
              var rawVal = 0;
              if (type === "CPU") rawVal = Number(p.PercentProcessorTime);
              else if (type === "MEMORY") rawVal = Number(p.WorkingSetPrivate);


              if (isFinite(rawVal) && rawVal > 0) {
                  procs.push({ name: rawName, pid: pid, rawTotal: rawVal });
              }
          }
          
          // Sort descending
          procs.sort(function(a, b) { return b.rawTotal - a.rawTotal; });
          
          var results = [];
          for (var i = 0; i < Math.min(limit, procs.length); i++) {
              var pItem = procs[i];
              var displayVal = 0;
              var formattedVal = "";
              
              if (type === "CPU") {
                  displayVal = Math.round(pItem.rawTotal / logicalProcs);
                  if (displayVal <= 0) displayVal = 1; // Show at least 1% if it's the top
                  formattedVal = displayVal; // Raw number for new PER column
              } else if (type === "MEMORY") {
                  displayVal = Math.round((pItem.rawTotal / totalMemBytes) * 1000) / 10;
                  formattedVal = displayVal; // Raw number for new PER column
              }
              
              // Get accurate process path from Win32_Process using PID (avoids noisy CLI arguments)
              var cmd = pItem.name;
              try {
                  var pQuery = svc.ExecQuery("SELECT Name, ExecutablePath FROM Win32_Process WHERE ProcessId = " + pItem.pid);
                  var eQ = new Enumerator(pQuery);
                  if (!eQ.atEnd()) {
                     var pInfo = eQ.item();
                     if (pInfo.ExecutablePath) cmd = pInfo.ExecutablePath;
                     else if (pInfo.Name) cmd = pInfo.Name;
                  }
              } catch(e){}
              
              // Escape single quotes for Oracle SQL
              cmd = String(cmd).replace(/'/g, "''");

              if (displayVal > 0) {
                  results.push({ name: pItem.name, pid: pItem.pid, cmd: cmd, value: formattedVal });
              }
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
          var sqlAlertC = "INSERT INTO " + TBL_CPU + " (" + COL_PROC + ") VALUES " +
            "(TO_DATE('" + ts + "','DD-MM-YYYY HH24:MI:SS'), '" + ip + "', " + topC.pid + ", '" + topC.cmd + "', " + topC.value + ");";
          WScript.Echo(sqlAlertC);
      }
  }

  if (memAvg >= threshMem) {
      var topMemProcs = getTopProcess(svc, "MEMORY", 1);
      for (var k = 0; k < topMemProcs.length; k++) {
          var topM = topMemProcs[k];
          var sqlAlertM = "INSERT INTO " + TBL_MEM + " (" + COL_PROC + ") VALUES " +
            "(TO_DATE('" + ts + "','DD-MM-YYYY HH24:MI:SS'), '" + ip + "', " + topM.pid + ", '" + topM.cmd + "', " + topM.value + ");";
          WScript.Echo(sqlAlertM);
      }
  }

})();
