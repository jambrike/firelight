# syntax=docker/dockerfile:1.7
# Multi-architecture manifest digest resolved 2026-08-07. Deployments build linux/amd64.
FROM public.ecr.aws/lambda/python:3.12@sha256:8e75daf5b46d34c8ea7336eb7a3e3dbd4d43032689dbd401e52c6d319d312e37 AS toolchain

ARG TARGETARCH
RUN test "${TARGETARCH}" = "amd64"

COPY docker/install_arduino_cli.py /tmp/install_arduino_cli.py
COPY docker/verify_arduino_index.py /tmp/verify_arduino_index.py
RUN python3 /tmp/install_arduino_cli.py \
      --version 1.5.1 \
      --sha256 28a8e119c498a25607821c36cb2dc49e8463941b261a0d99091baa7bc692dd2b \
      --destination /usr/local/bin/arduino-cli

COPY arduino-cli.yaml /opt/arduino/arduino-cli.yaml
RUN mkdir -p /opt/arduino/data /tmp/arduino-downloads /tmp/arduino-user \
    && arduino-cli --config-file /opt/arduino/arduino-cli.yaml core update-index \
    && python3 /tmp/verify_arduino_index.py /opt/arduino/data/package_index.json \
    && arduino-cli --config-file /opt/arduino/arduino-cli.yaml core install arduino:avr@1.8.6 \
    && rm -rf /tmp/arduino-downloads /tmp/arduino-user /opt/arduino/data/staging \
    && chmod -R a=rX /opt/arduino

FROM public.ecr.aws/lambda/python:3.12@sha256:8e75daf5b46d34c8ea7336eb7a3e3dbd4d43032689dbd401e52c6d319d312e37

LABEL org.opencontainers.image.title="Firelight Arduino compiler" \
      org.opencontainers.image.description="Private, bounded Arduino Nano old-bootloader compiler Lambda" \
      org.opencontainers.image.source="https://github.com/jambrike/firelight" \
      io.firelight.arduino-cli.version="1.5.1" \
      io.firelight.arduino-avr-core.version="1.8.6" \
      io.firelight.arduino-avr-core.sha256="ff1d17274b5a952f172074bd36c3924336baefded0232e10982f8999c2f7c3b6"

COPY --from=toolchain /usr/local/bin/arduino-cli /usr/local/bin/arduino-cli
COPY --from=toolchain /opt/arduino /opt/arduino
COPY app.py ${LAMBDA_TASK_ROOT}/app.py

CMD ["app.lambda_handler"]
