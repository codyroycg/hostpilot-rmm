# HostPilot task: reinstall a package
#__ARGS__
#__INCLUDE:_pm.sh__
case "$pm" in
  apt-get) apt-get -y -q install --reinstall "$A_name" ;;
  dnf|yum) "$pm" -y reinstall "$A_name" ;;
  zypper) zypper -n install -f "$A_name" ;;
  apk) apk fix "$A_name" ;;
  pacman) pacman -S --noconfirm "$A_name" ;;
esac
