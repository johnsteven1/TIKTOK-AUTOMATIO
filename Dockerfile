# Match the Playwright Python package to the browser binaries in this image.
FROM mcr.microsoft.com/playwright/python:v1.55.0-noble

ENV PYTHONUNBUFFERED=1 \
    DATA_DIR=/var/data \
    HOST=0.0.0.0
WORKDIR /app

COPY requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt
COPY . .

# One synchronous worker/thread is intentional: the current Playwright sync
# browser object must stay on one thread. Render's persistent disk is mounted
# at /var/data by render.yaml.
CMD ["sh", "-c", "gunicorn --bind 0.0.0.0:${PORT:-10000} --workers 1 --threads 1 --timeout 120 app:app"]
