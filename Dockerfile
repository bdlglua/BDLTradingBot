FROM python:3.12-slim
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 BITPANDA_STATE_DIR=/data
COPY --chown=10001:10001 access.py bot.py bitpanda.py web.py container_start.py ./
COPY --chown=10001:10001 static/ ./static/
COPY --chown=10001:10001 examples/prices.csv ./examples/prices.csv
RUN mkdir -p /data && chown 10001:10001 /data
EXPOSE 8000
ENTRYPOINT ["python", "container_start.py"]
