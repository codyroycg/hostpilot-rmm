# HostPilot task: remove a package
#__ARGS__
#__INCLUDE:_pm.sh__
case "$pm" in
  apt-get) apt-get -y -q remove "$A_name" ;;
  dnf|yum) "$pm" -y remove "$A_name" ;;
  zypper) zypper -n remove "$A_name" ;;
  apk) apk del "$A_name" ;;
  pacman) pacman -R --noconfirm "$A_name" ;;
esac
