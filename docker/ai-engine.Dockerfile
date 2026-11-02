FROM python:3.13-slim
WORKDIR /app
COPY ai-engine/requirements.txt requirements.txt
RUN pip install --no-cache-dir -r requirements.txt
COPY ai-engine/app app
RUN mkdir -p models datasets
EXPOSE 8500
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8500"]
