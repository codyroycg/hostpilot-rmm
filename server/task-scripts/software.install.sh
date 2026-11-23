# HostPilot task: install a package
#__ARGS__
#__INCLUDE:_pm.sh__
case "$pm" in
  apt-get) apt-get update -qq && apt-get -y -q install "$A_id" ;;
  dnf|yum) "$pm" -y install "$A_id" ;;
  zypper) zypper -n install "$A_id" ;;
  apk) apk add "$A_id" ;;
  pacman) pacman -S --noconfirm "$A_id" ;;
esac
