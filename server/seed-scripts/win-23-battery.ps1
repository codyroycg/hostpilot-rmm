# name: Battery health
# category: Hardware
# description: Battery design capacity versus current full charge (wear), charge level and cycle count on laptops
# timeout: 120
$b = Get-CimInstance Win32_Battery -ErrorAction SilentlyContinue
if (-not $b) { 'No battery found (desktop or server).'; exit 0 }
$xml = Join-Path $env:TEMP 'hp-battery.xml'
powercfg /batteryreport /xml /output $xml 2>&1 | Out-Null
if (Test-Path $xml) {
  [xml]$r = Get-Content $xml -Raw
  foreach ($bat in $r.BatteryReport.Batteries.Battery) {
    $design = [double]$bat.DesignCapacity; $full = [double]$bat.FullChargeCapacity
    "Battery:          $($bat.Manufacturer) $($bat.Id)"
    "Chemistry:        $($bat.Chemistry)"
    "Design capacity:  {0:N0} mWh" -f $design
    "Full charge now:  {0:N0} mWh" -f $full
    if ($design -gt 0) { "Health:           {0:N0}% of original" -f (100 * $full / $design) }
    if ($bat.CycleCount) { "Cycle count:      $($bat.CycleCount)" }
    ''
  }
  Remove-Item $xml -Force -ErrorAction SilentlyContinue
}
foreach ($x in @($b)) { "Charge now:       $($x.EstimatedChargeRemaining)%  ($(@{1='discharging';2='on AC power';3='fully charged';6='charging';7='charging (high)';8='charging (low)';9='charging (critical)'}[[int]$x.BatteryStatus]))" }
