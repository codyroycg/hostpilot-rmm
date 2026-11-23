# HostPilot task: delete a file or folder (recursively)
#__ARGS__
p="$A_path"
case "$p" in
  /|/bin|/boot|/dev|/etc|/home|/lib|/lib64|/proc|/root|/sbin|/sys|/usr|/var) echo "Refusing to delete $p" >&2; exit 1 ;;
esac
[ -e "$p" ] || [ -L "$p" ] || { echo "Not found: $p" >&2; exit 1; }
rm -rf -- "$p" && echo "Deleted $p"
