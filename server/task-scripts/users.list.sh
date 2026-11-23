# HostPilot task: list local accounts (root + regular users)
# Output: U\t<name>\t<enabled 0|1>\t<admin 0|1>\t<full name>\t<last logon>\t<home, shell>
#__ARGS__
getent passwd | while IFS=: read -r name _ uid _ gecos home shell; do
  { [ "$uid" -eq 0 ] || [ "$uid" -ge 1000 ]; } && [ "$uid" -ne 65534 ] || continue
  enabled=1
  st="$(passwd -S "$name" 2>/dev/null | awk '{print $2}')"
  case "$st" in L|LK) enabled=0 ;; esac
  case "$shell" in */nologin|*/false) enabled=0 ;; esac
  admin=0
  if [ "$uid" -eq 0 ]; then admin=1
  else for g in $(id -nG "$name" 2>/dev/null); do case "$g" in sudo|wheel|admin) admin=1 ;; esac; done
  fi
  printf 'U\t%s\t%s\t%s\t%s\t0\t%s\n' "$name" "$enabled" "$admin" "${gecos%%,*}" "$home, $shell"
done
