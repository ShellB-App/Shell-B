# Shell:B Guest cell: the image each guest's own Shell:B runs in (server/cells.py starts and stops the containers).
#
# Only Python and the packages Shell:B Web imports live here. The code (server/, cell/), the built UI and the guest's
# data are mounted at run time, read-only except the guest's /app/data, so the image doesn't change when Shell:B does.
# Rebuild after cell/requirements.txt changes:
#     docker build -t shellb-cell:latest ~/shellb/web/cell
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1

# libgl1 and libglib2.0-0 for opencv-python, libsndfile1 for soundfile, tzdata so the guest's day matches the host's
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3.12 python3.12-venv libgl1 libglib2.0-0 libsndfile1 \
      ca-certificates tzdata \
 && rm -rf /var/lib/apt/lists/*

COPY requirements.txt /opt/requirements.txt
RUN python3.12 -m venv /opt/venv \
 && /opt/venv/bin/pip install -r /opt/requirements.txt

# No setuid or setgid programs, so nothing in a cell can gain privileges (cells run with every capability dropped
# and as their own unprivileged uid; no-new-privileges isn't used because the snap dockerd's AppArmor breaks exec
# with it).
RUN find / -xdev -perm /6000 -type f -exec chmod a-s {} + ; true

ENV PATH=/opt/venv/bin:/usr/local/bin:/usr/bin:/bin
WORKDIR /app/server
CMD ["/opt/venv/bin/python", "/app/cell/entry.py"]
