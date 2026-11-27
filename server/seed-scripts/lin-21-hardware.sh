# name: Hardware details
# category: Hardware
# description: Manufacturer, model, serial number, BIOS, CPU, memory modules, disks and PCI / USB devices
# timeout: 120
echo "=== System ==="
if command -v dmidecode >/dev/null 2>&1; then
  for k in system-manufacturer system-product-name system-serial-number baseboard-product-name bios-version bios-release-date; do
    printf '%-24s %s\n' "$k" "$(dmidecode -s "$k" 2>/dev/null | head -n 1)"
  done
else
  for f in sys_vendor product_name product_serial board_name bios_version bios_date; do
    printf '%-24s %s\n' "$f" "$(cat /sys/class/dmi/id/$f 2>/dev/null)"
  done
fi
echo
echo "=== CPU ==="
lscpu 2>/dev/null | grep -E '^(Model name|Socket|Core|Thread|CPU\(s\)|CPU max MHz|Architecture)'
echo
echo "=== Memory ==="
free -h
command -v dmidecode >/dev/null 2>&1 && dmidecode -t memory 2>/dev/null | grep -E '^\s+(Size|Type|Speed|Manufacturer|Locator):' | grep -v 'No Module' | paste - - - - - 2>/dev/null | head -n 16
echo
echo "=== Disks ==="
lsblk -d -o NAME,MODEL,SERIAL,SIZE,ROTA,TRAN 2>/dev/null | grep -v '^loop'
echo
command -v lspci >/dev/null 2>&1 && { echo "=== PCI devices ==="; lspci 2>/dev/null | grep -Ei 'vga|3d|network|ethernet|wireless|audio|storage|nvme|sata|raid'; echo; }
command -v lsusb >/dev/null 2>&1 && { echo "=== USB devices ==="; lsusb 2>/dev/null | grep -vi 'root hub'; }
exit 0
