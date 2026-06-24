# Multi-stage build fixture (add-docker-container-graph).
FROM python:3.12-slim AS builder
WORKDIR /app
COPY requirements.txt .
RUN pip install -r requirements.txt

FROM builder AS test
RUN pytest

FROM python:3.12-slim
WORKDIR /app
COPY --from=builder /app /app
CMD ["python", "main.py"]
