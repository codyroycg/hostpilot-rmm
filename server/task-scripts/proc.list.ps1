# HostPilot task: running processes with current CPU (1 s sample)
# Output: T\tpid\tname\tcpu_pct\tmem_bytes\tuser\tpath\tstart_unix\tdescription
#__ARGS__
$ErrorActionPreference = 'Continue'
$cores = [Environment]::ProcessorCount
$t1 = @{}; foreach ($p in Get-Process) { try { $t1[$p.Id] = $p.TotalProcessorTime.TotalMilliseconds } catch {} }
$sw = [Diagnostics.Stopwatch]::StartNew(); Start-Sleep -Milliseconds 1000; $ms = $sw.Elapsed.TotalMilliseconds
$owners = @{}
try { foreach ($p in Get-Process -IncludeUserName -ErrorAction Stop) { $owners[$p.Id] = $p.UserName } } catch {}
foreach ($p in Get-Process) {
    $cpu = 0
    try { if ($t1.ContainsKey($p.Id)) { $cpu = [math]::Round(($p.TotalProcessorTime.TotalMilliseconds - $t1[$p.Id]) / $ms / $cores * 100, 1) } } catch {}
    $start = ''; try { $start = ([DateTimeOffset]$p.StartTime).ToUnixTimeSeconds() } catch {}
    $path = ''; try { $path = $p.Path } catch {}
    $desc = ''; try { $desc = $p.Description } catch {}
    $f = @($p.Id, $p.ProcessName, [math]::Max(0, $cpu), [int64]$p.WorkingSet64, $owners[$p.Id], $path, $start, $desc) | ForEach-Object { ([string]$_ -replace "[`t`r`n]", ' ') }
    "T`t" + ($f -join "`t")
}
