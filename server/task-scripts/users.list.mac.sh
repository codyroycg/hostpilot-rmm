# HostPilot task: list local accounts (macOS)
# Output: U\t<name>\t<enabled 0|1>\t<admin 0|1>\t<full name>\t<last logon>\t<home, shell>
#__ARGS__
admins=" $(dscl . -read /Groups/admin GroupMembership 2>/dev/null | cut -d: -f2) "
dscl . -list /Users UniqueID | while read -r name uid; do
  [ "$uid" -ge 500 ] 2>/dev/null || [ "$name" = root ] || continue
  case "$name" in _*|daemon|nobody) continue ;; esac
  real=$(dscl . -read "/Users/$name" RealName 2>/dev/null | sed '1s/^RealName:[[:space:]]*//' | tr '\n' ' ' | sed 's/^ *//;s/ *$//')
  home=$(dscl . -read "/Users/$name" NFSHomeDirectory 2>/dev/null | awk '{print $2}')
  shell=$(dscl . -read "/Users/$name" UserShell 2>/dev/null | awk '{print $2}')
  enabled=1; dscl . -read "/Users/$name" AuthenticationAuthority 2>/dev/null | grep -q DisabledUser && enabled=0
  [ "$name" = root ] && { [ "$shell" = /usr/bin/false ] || [ -z "$(dscl . -read /Users/root AuthenticationAuthority 2>/dev/null)" ]; } && enabled=0
  admin=0; case "$admins" in *" $name "*) admin=1 ;; esac
  printf 'U\t%s\t%s\t%s\t%s\t0\t%s\n' "$name" "$enabled" "$admin" "$real" "$home, $shell"
done
