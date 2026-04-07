FROM perl:5.36-slim

WORKDIR /app

# Dependencias del sistema (gcc para módulos XS de Perl)
RUN apt-get update && apt-get install -y \
    libssl-dev libssl3 ca-certificates \
    build-essential libexpat1-dev \
    && rm -rf /var/lib/apt/lists/*

# Módulos Perl no-core necesarios
# (Digest::SHA, Encode, Scalar::Util, List::Util, MIME::Base64,
#  File::Path ya vienen en perl:5.36 — no los reinstalamos)
RUN cpanm --notest --quiet \
    HTTP::Daemon \
    HTTP::Message \
    HTTP::Tiny \
    JSON \
    Net::SSLeay \
    IO::Socket::SSL

COPY . .

# Crear carpetas de datos
RUN mkdir -p data uploads

EXPOSE 3000

CMD ["perl", "server.pl"]
