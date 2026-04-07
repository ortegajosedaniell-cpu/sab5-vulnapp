FROM perl:5.36-slim

WORKDIR /app

# Dependencias del sistema (incluye gcc para módulos XS)
RUN apt-get update && apt-get install -y \
    libssl-dev ca-certificates build-essential libexpat1-dev \
    && rm -rf /var/lib/apt/lists/*

# Módulos Perl necesarios
RUN cpanm --notest --quiet \
    HTTP::Daemon \
    HTTP::Status \
    HTTP::Tiny \
    JSON \
    MIME::Base64 \
    Digest::SHA \
    File::Path \
    Encode \
    Scalar::Util \
    List::Util \
    Net::SSLeay \
    IO::Socket::SSL

COPY . .

# Crear carpetas de datos (se sobreescriben con el volumen en Railway)
RUN mkdir -p data uploads

EXPOSE 3000

CMD ["perl", "server.pl"]
