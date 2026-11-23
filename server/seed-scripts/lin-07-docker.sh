# name: Docker containers status
# category: Inventory
# description: Lists containers and their status / resource usage (if Docker is installed)
# timeout: 120
if ! command -v docker >/dev/null; then echo "Docker is not installed"; exit 0; fi
docker ps -a --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}'
echo
docker stats --no-stream --format 'table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}'
