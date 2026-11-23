# HostPilot task: delete a file or folder (macOS)
#__ARGS__
p="${A_path%/}"; [ -z "$p" ] && p=/
case "$p" in
  /|/System|/System/*|/Library|/Applications|/Users|/bin|/sbin|/usr|/usr/*|/private|/private/etc|/private/var|/etc|/var|/Volumes|/cores|/dev)
    echo "Refusing to delete $p" >&2; exit 1 ;;
esac
[ -e "$p" ] || [ -L "$p" ] || { echo "Not found: $p" >&2; exit 1; }
rm -rf -- "$p" && echo "Deleted $p"
