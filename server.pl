#!/usr/bin/perl
use strict;
use warnings;
use HTTP::Daemon;
use HTTP::Response;
use HTTP::Status;
use JSON qw(encode_json decode_json);
use MIME::Base64 qw(encode_base64 decode_base64);
use Digest::SHA qw(hmac_sha256_hex sha256_hex);
use File::Path qw(make_path);
use File::Basename qw(basename dirname);
use POSIX qw(strftime floor);
use Time::HiRes qw(time);
use Encode qw(encode_utf8 decode_utf8);
use Scalar::Util qw(looks_like_number);
use List::Util qw(first);
use HTTP::Tiny;

# ── Cargar .env si existe ────────────────────────────────────────────────────
my $ROOT = dirname(__FILE__);
if (-f "$ROOT/.env") {
    open my $fh, '<', "$ROOT/.env" or ();
    while (<$fh>) {
        s/\r?\n$//;          # eliminar \r\n o \n
        s/^\s+|\s+$//g;      # trim
        next if /^#/ || /^$/;
        if (/^(\w+)\s*=\s*(.+)$/) { $ENV{$1} = $2; }  # siempre sobrescribir
    }
    close $fh;
}

# ── Config ───────────────────────────────────────────────────────────────────
my $PORT       = $ENV{PORT}              || 3000;
my $SECRET     = $ENV{JWT_SECRET}        || 'vuln_secret_2024_seguridad_privada';
my $AI_KEY     = $ENV{ANTHROPIC_API_KEY} || '';
my $DATA_DIR   = "$ROOT/data";
my $UPLOADS    = "$ROOT/uploads";
my $PUBLIC     = "$ROOT/public";

# ── Init directorios y datos ─────────────────────────────────────────────────
make_path($DATA_DIR, $UPLOADS);

unless (-f "$DATA_DIR/users.json") {
    my ($salt, $hash) = _new_password('admin123');
    write_json("$DATA_DIR/users.json", [{
        id => 1, username => 'admin', password => "$salt:$hash",
        full_name => 'Administrador', role => 'admin',
        active => 1, created_at => now(),
    }]);
    print "✔ Usuario admin creado: admin / admin123\n";
}
write_json("$DATA_DIR/reports.json", []) unless -f "$DATA_DIR/reports.json";

# ── Servidor ─────────────────────────────────────────────────────────────────
my $d = HTTP::Daemon->new(
    LocalPort => $PORT, LocalAddr => '0.0.0.0', ReuseAddr => 1,
) or die "No se pudo iniciar: $!\n";

# ── MIME types (debe declararse ANTES del loop del servidor) ─────────────────
my %MIME = (
    'html' => 'text/html; charset=utf-8',
    'css'  => 'text/css; charset=utf-8',
    'js'   => 'application/javascript; charset=utf-8',
    'json' => 'application/json',
    'png'  => 'image/png',
    'jpg'  => 'image/jpeg',
    'jpeg' => 'image/jpeg',
    'webp' => 'image/webp',
    'gif'  => 'image/gif',
    'ico'  => 'image/x-icon',
    'svg'  => 'image/svg+xml',
);

print "\n🔒 SecureReport en http://localhost:$PORT\n";
print "   Admin: admin / admin123\n\n";
$| = 1;

while (my $c = $d->accept) {
    while (my $r = $c->get_request) {
        my $res = handle($r);
        $c->send_response($res);
    }
    $c->close;
}

# ═══════════════════════════════════════════════════════════════════════════════
# DISPATCHER
# ═══════════════════════════════════════════════════════════════════════════════
sub handle {
    my ($req) = @_;
    my $method = $req->method;
    my $path   = $req->url->path;
    my $query  = $req->url->query // '';

    # CORS preflight
    if ($method eq 'OPTIONS') {
        my $r = HTTP::Response->new(204);
        add_cors($r); return $r;
    }

    # ── Static / uploads ────────────────────────────────────────────────────
    if ($path =~ m{^/uploads/(.+)$}) {
        return serve_file("$UPLOADS/$1");
    }
    if (!$path || $path eq '/') { return serve_file("$PUBLIC/index.html"); }
    if ($path !~ m{^/api/}) { return serve_file("$PUBLIC$path"); }

    # ── API ──────────────────────────────────────────────────────────────────
    my $body   = $req->content // '';
    my $ct     = $req->header('Content-Type') // '';
    my $bearer = ($req->header('Authorization') // '') =~ s/^Bearer\s+//r;

    # Parse JSON body
    my $json = {};
    if ($ct =~ /application\/json/ && length $body) {
        eval { $json = decode_json(encode_utf8($body)); };
    }

    # Parse multipart
    my ($fields, $files) = ({}, []);
    if ($ct =~ /multipart\/form-data/) {
        ($fields, $files) = parse_multipart($ct, $body);
    } elsif ($ct =~ /application\/x-www-form-urlencoded/) {
        $fields = parse_qs($body);
    }

    # Merge json + fields
    my %data = (%$json, %$fields);

    # Auth
    my $user = verify_token($bearer);

    # ── Routing ──────────────────────────────────────────────────────────────

    # POST /api/auth/login
    if ($method eq 'POST' && $path eq '/api/auth/login') {
        my $users = read_json("$DATA_DIR/users.json");
        my $u = first { lc($_->{username}) eq lc($data{username}//'') && $_->{active} } @$users;
        return err(401,'Credenciales incorrectas') unless $u;
        return err(401,'Credenciales incorrectas') unless check_password($data{password}//'', $u->{password});
        my $token = make_token($u);
        return ok({ token => $token, user => pub_user($u) });
    }

    # GET /api/auth/me
    if ($method eq 'GET' && $path eq '/api/auth/me') {
        return err(401,'No autorizado') unless $user;
        return ok({ user => $user });
    }

    # POST /api/auth/change-password
    if ($method eq 'POST' && $path eq '/api/auth/change-password') {
        return err(401,'No autorizado') unless $user;
        my $users = read_json("$DATA_DIR/users.json");
        my ($u) = grep { $_->{id} == $user->{id} } @$users;
        return err(401,'Contraseña actual incorrecta') unless check_password($data{current_password}//'', $u->{password});
        return err(400,'Mínimo 6 caracteres') unless length($data{new_password}//'') >= 6;
        my ($s,$h) = _new_password($data{new_password});
        $u->{password} = "$s:$h";
        write_json("$DATA_DIR/users.json", $users);
        return ok({ message => 'Contraseña actualizada' });
    }

    # ── /api/users ───────────────────────────────────────────────────────────
    if ($path eq '/api/users') {
        return err(401,'No autorizado') unless $user;
        return err(403,'Solo admin') unless $user->{role} eq 'admin';

        if ($method eq 'GET') {
            my $users = read_json("$DATA_DIR/users.json");
            return ok([ map { pub_user($_) } @$users ]);
        }
        if ($method eq 'POST') {
            return err(400,'Campos requeridos') unless $data{username} && $data{full_name} && $data{role};
            return err(400,'Mínimo 6 caracteres') unless length($data{password}//'') >= 6;
            return err(400,'Rol inválido') unless $data{role} =~ /^(admin|supervisor)$/;
            my $users = read_json("$DATA_DIR/users.json");
            return err(409,'Usuario ya existe') if first { lc($_->{username}) eq lc($data{username}) } @$users;
            my $next_id = (List::Util::max(map { $_->{id} } @$users) // 0) + 1;
            my ($s,$h)  = _new_password($data{password});
            my $nu = { id => $next_id, username => lc($data{username}),
                       password => "$s:$h", full_name => $data{full_name},
                       role => $data{role}, active => 1, created_at => now() };
            push @$users, $nu;
            write_json("$DATA_DIR/users.json", $users);
            return ok({ id => $next_id, message => 'Usuario creado' }, 201);
        }
    }

    # ── /api/users/:id ───────────────────────────────────────────────────────
    if ($path =~ m{^/api/users/(\d+)$}) {
        my $uid = $1 + 0;
        return err(401,'No autorizado') unless $user;
        return err(403,'Solo admin') unless $user->{role} eq 'admin';
        my $users = read_json("$DATA_DIR/users.json");
        my ($u) = grep { $_->{id} == $uid } @$users;
        return err(404,'Usuario no encontrado') unless $u;

        if ($method eq 'PUT') {
            return err(400,'No puede desactivarse') if $uid == $user->{id} && defined $data{active} && $data{active} == 0;
            $u->{full_name} = $data{full_name} if $data{full_name};
            $u->{role}      = $data{role}      if $data{role} && $data{role} =~ /^(admin|supervisor)$/;
            $u->{active}    = $data{active} + 0 if defined $data{active};
            if ($data{password} && length($data{password}) >= 6) {
                my ($s,$h) = _new_password($data{password});
                $u->{password} = "$s:$h";
            }
            write_json("$DATA_DIR/users.json", $users);
            return ok({ message => 'Usuario actualizado' });
        }
        if ($method eq 'DELETE') {
            return err(400,'No puede eliminarse a sí mismo') if $uid == $user->{id};
            @$users = grep { $_->{id} != $uid } @$users;
            write_json("$DATA_DIR/users.json", $users);
            return ok({ message => 'Usuario eliminado' });
        }
    }

    # ── /api/network-info ────────────────────────────────────────────────────
    if ($method eq 'GET' && $path eq '/api/network-info') {
        return err(401,'No autorizado') unless $user;
        return err(403,'Solo admin') unless $user->{role} eq 'admin';
        my $ip = '127.0.0.1';
        my @lines = `ipconfig 2>nul`;
        for my $line (@lines) {
            if ($line =~ /IPv4[^:]*:\s*(192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+)/) {
                $ip = $1; last;
            }
        }
        return ok({ url => "http://$ip:$PORT", ip => $ip, port => $PORT+0 });
    }

    # ── /api/reports/export/csv ───────────────────────────────────────────────
    if ($method eq 'GET' && $path eq '/api/reports/export/csv') {
        return err(401,'No autorizado') unless $user;
        return err(403,'Solo admin') unless $user->{role} eq 'admin';
        my $reports = read_json("$DATA_DIR/reports.json");
        my $users   = read_json("$DATA_DIR/users.json");
        my $date    = strftime('%Y-%m-%d', localtime);

        # BOM UTF-8 para Excel
        my $csv = "\xEF\xBB\xBF";
        $csv .= "ID,Supervisor,Cliente,Dirección,Tipo Servicio,Fecha,Probabilidad,Impacto,Puntuación,Nivel Riesgo,Descripción,Recomendaciones\n";
        for my $r (reverse sort { $a->{id} <=> $b->{id} } @$reports) {
            my ($sup) = grep { $_->{id} == $r->{supervisor_id} } @$users;
            my $sname = $sup ? $sup->{full_name} : '?';
            my $desc  = $r->{vulnerability_description} // '';
            my $recs  = ref($r->{recommendations}) eq 'ARRAY'
                ? join(' | ', @{$r->{recommendations}})
                : ($r->{recommendations} // '');
            # Escapar comillas dobles dentro de campos
            for ($desc, $recs) { s/"/""/g }
            $csv .= join(',',
                $r->{id},
                qq("$sname"),
                qq("$r->{client}"),
                qq("$r->{address}"),
                qq("$r->{service_type}"),
                substr($r->{report_date}//'-', 0, 10),
                $r->{probability}+0,
                $r->{impact}+0,
                $r->{risk_score}+0,
                qq("$r->{risk_level}"),
                qq("$desc"),
                qq("$recs"),
            ) . "\n";
        }
        my $res = HTTP::Response->new(200);
        $res->header('Content-Type'        => 'text/csv; charset=utf-8');
        $res->header('Content-Disposition' => qq(attachment; filename="informes_sab5_$date.csv"));
        add_cors($res); $res->content($csv); return $res;
    }

    # ── /api/reports/:id/pdf ──────────────────────────────────────────────────
    if ($method eq 'GET' && $path =~ m{^/api/reports/(\d+)/pdf$}) {
        my $rid = $1 + 0;
        return err(401,'No autorizado') unless $user;
        my $reports = read_json("$DATA_DIR/reports.json");
        my ($r) = grep { $_->{id} == $rid } @$reports;
        return err(404,'No encontrado') unless $r;
        return err(403,'Sin acceso') if $user->{role} ne 'admin' && $r->{supervisor_id} != $user->{id};
        my $users = read_json("$DATA_DIR/users.json");
        my ($sup) = grep { $_->{id} == $r->{supervisor_id} } @$users;
        $r->{supervisor_name} = $sup ? $sup->{full_name} : '?';
        my $html = render_report_html($r);
        my $res  = HTTP::Response->new(200);
        $res->header('Content-Type' => 'text/html; charset=utf-8');
        add_cors($res); $res->content(encode_utf8($html)); return $res;
    }

    # ── /api/reports ─────────────────────────────────────────────────────────
    if ($path eq '/api/reports') {
        return err(401,'No autorizado') unless $user;

        if ($method eq 'GET') {
            my $qs = parse_qs($query);
            my $reports = read_json("$DATA_DIR/reports.json");
            my $users   = read_json("$DATA_DIR/users.json");
            my @filtered = @$reports;

            # Supervisores solo ven los suyos
            @filtered = grep { $_->{supervisor_id} == $user->{id} } @filtered
                unless $user->{role} eq 'admin';

            @filtered = grep { lc($_->{client}) =~ lc($qs->{client}) } @filtered if $qs->{client};
            @filtered = grep { $_->{risk_level} eq $qs->{risk_level} } @filtered  if $qs->{risk_level};
            @filtered = grep { ($_->{report_date}//'') ge $qs->{date_from} } @filtered if $qs->{date_from};
            @filtered = grep { ($_->{report_date}//'') le $qs->{date_to}.'T23:59:59' } @filtered if $qs->{date_to};
            @filtered = grep { $_->{supervisor_id} == $qs->{supervisor_id} } @filtered if $qs->{supervisor_id};

            # Ordenar DESC
            @filtered = reverse sort { $a->{id} <=> $b->{id} } @filtered;

            # Agregar nombre supervisor
            my %user_map = map { $_->{id} => $_->{full_name} } @$users;
            for my $r (@filtered) {
                $r->{supervisor_name} = $user_map{$r->{supervisor_id}} // '?';
            }
            return ok(\@filtered);
        }

        if ($method eq 'POST') {
            my %d = (%data, map { $_->{name} => $_->{value} } ()); # merge
            return err(400,'Cliente, dirección y tipo requeridos')
                unless $d{client} && $d{address} && $d{service_type};

            my $prob  = ($d{probability}  || 1) + 0;
            my $imp   = ($d{impact}       || 1) + 0;
            my $score = $prob * $imp;
            my $level = risk_level($score);

            my $checklist = {};
            if ($d{checklist}) {
                eval { $checklist = decode_json($d{checklist}); };
                $checklist = {} if $@;
            }

            my $reports = read_json("$DATA_DIR/reports.json");
            my $next_id = (List::Util::max(map { $_->{id} } @$reports) // 0) + 1;

            my $report = {
                id                       => $next_id,
                supervisor_id            => $user->{id},
                client                   => $d{client},
                address                  => $d{address},
                service_type             => $d{service_type},
                report_date              => $d{report_date} || now_short(),
                vulnerability_description => $d{vulnerability_description} // '',
                checklist                => $checklist,
                probability              => $prob,
                impact                   => $imp,
                risk_score               => $score,
                risk_level               => $level,
                recommendations          => $d{recommendations} // '',
                images                   => [],
                created_at               => now(),
            };

            # Guardar imágenes globales
            for my $f (@$files) {
                next unless $f->{name} eq 'images' && length($f->{data}) > 0;
                my $ext  = ($f->{filename} =~ /(\.[^.]+)$/) ? lc($1) : '.jpg';
                next unless $ext =~ /^\.(jpg|jpeg|png|webp|gif)$/;
                my $fname = sprintf('%d-%06d%s', time()*1000, int(rand(1000000)), $ext);
                open my $fh, '>:raw', "$UPLOADS/$fname" or next;
                print $fh $f->{data}; close $fh;
                push @{$report->{images}}, { id => int(rand(99999)), filename => $fname };
            }

            # Guardar fotos por hallazgo (fp_AREAKEY)
            for my $f (@$files) {
                next unless $f->{name} =~ /^fp_(\w+)$/ && length($f->{data}) > 0;
                my $area_key = $1;
                my $ext  = ($f->{filename} =~ /(\.[^.]+)$/) ? lc($1) : '.jpg';
                next unless $ext =~ /^\.(jpg|jpeg|png|webp|gif)$/;
                my $fname = sprintf('fp-%s-%06d%s', $area_key, int(rand(1000000)), $ext);
                open my $fh, '>:raw', "$UPLOADS/$fname" or next;
                print $fh $f->{data}; close $fh;
                $report->{areas_data} //= {};
                $report->{areas_data}{$area_key} //= { photos => [] };
                push @{$report->{areas_data}{$area_key}{photos}}, $fname;
            }

            push @$reports, $report;
            write_json("$DATA_DIR/reports.json", $reports);
            return ok({ id => $next_id, risk_score => $score, risk_level => $level,
                        message => 'Informe creado' }, 201);
        }
    }

    # ── /api/reports/:id ─────────────────────────────────────────────────────
    if ($path =~ m{^/api/reports/(\d+)$}) {
        my $rid = $1 + 0;
        return err(401,'No autorizado') unless $user;
        my $reports = read_json("$DATA_DIR/reports.json");
        my ($r) = grep { $_->{id} == $rid } @$reports;
        return err(404,'Informe no encontrado') unless $r;
        return err(403,'Sin acceso') if $user->{role} ne 'admin' && $r->{supervisor_id} != $user->{id};

        if ($method eq 'GET') {
            my $users = read_json("$DATA_DIR/users.json");
            my ($sup) = grep { $_->{id} == $r->{supervisor_id} } @$users;
            my %out = (%$r, supervisor_name => ($sup ? $sup->{full_name} : '?'));
            return ok(\%out);
        }

        if ($method eq 'PUT') {
            my %d = %data;
            $r->{client}       = $d{client}       if $d{client};
            $r->{address}      = $d{address}       if $d{address};
            $r->{service_type} = $d{service_type}  if $d{service_type};
            $r->{report_date}  = $d{report_date}   if $d{report_date};
            $r->{vulnerability_description} = $d{vulnerability_description}
                if defined $d{vulnerability_description};
            $r->{recommendations} = $d{recommendations}
                if defined $d{recommendations};
            if ($d{probability} || $d{impact}) {
                $r->{probability} = ($d{probability} || $r->{probability}) + 0;
                $r->{impact}      = ($d{impact}      || $r->{impact})      + 0;
                $r->{risk_score}  = $r->{probability} * $r->{impact};
                $r->{risk_level}  = risk_level($r->{risk_score});
            }
            if ($d{checklist}) {
                eval { $r->{checklist} = decode_json($d{checklist}); };
            }
            # Nuevas imágenes
            for my $f (@$files) {
                next unless $f->{name} eq 'images' && length($f->{data}) > 0;
                my $ext = ($f->{filename} =~ /(\.[^.]+)$/) ? lc($1) : '.jpg';
                next unless $ext =~ /^\.(jpg|jpeg|png|webp|gif)$/;
                my $fname = sprintf('%d-%06d%s', time()*1000, int(rand(1000000)), $ext);
                open my $fh, '>:raw', "$UPLOADS/$fname" or next;
                print $fh $f->{data}; close $fh;
                push @{$r->{images}}, { id => int(rand(99999)), filename => $fname };
            }
            write_json("$DATA_DIR/reports.json", $reports);
            return ok({ risk_score => $r->{risk_score}, risk_level => $r->{risk_level},
                        message => 'Informe actualizado' });
        }

        if ($method eq 'DELETE') {
            return err(403,'Solo admin') unless $user->{role} eq 'admin';
            # Borrar imágenes del disco
            for my $img (@{$r->{images}//[]}) {
                my $fp = "$UPLOADS/$img->{filename}";
                unlink $fp if -f $fp;
            }
            @$reports = grep { $_->{id} != $rid } @$reports;
            write_json("$DATA_DIR/reports.json", $reports);
            return ok({ message => 'Informe eliminado' });
        }
    }

    # ── /api/reports/:id/images/:imgId ───────────────────────────────────────
    if ($method eq 'DELETE' && $path =~ m{^/api/reports/(\d+)/images/(\d+)$}) {
        my ($rid, $iid) = ($1+0, $2+0);
        return err(401,'No autorizado') unless $user;
        my $reports = read_json("$DATA_DIR/reports.json");
        my ($r) = grep { $_->{id} == $rid } @$reports;
        return err(404,'No encontrado') unless $r;
        return err(403,'Sin acceso') if $user->{role} ne 'admin' && $r->{supervisor_id} != $user->{id};
        my ($img) = grep { $_->{id} == $iid } @{$r->{images}//[]};
        return err(404,'Imagen no encontrada') unless $img;
        unlink "$UPLOADS/$img->{filename}" if -f "$UPLOADS/$img->{filename}";
        @{$r->{images}} = grep { $_->{id} != $iid } @{$r->{images}};
        write_json("$DATA_DIR/reports.json", $reports);
        return ok({ message => 'Imagen eliminada' });
    }

    # ── /api/ai/generate-report ───────────────────────────────────────────────
    if ($method eq 'POST' && $path eq '/api/ai/generate-report') {
        return err(401,'No autorizado') unless $user;
        unless ($AI_KEY) {
            return ok({ descripcion => '', recomendaciones => '',
                        fallback => JSON::true, error => 'Clave API no configurada' });
        }
        my $result = call_claude_api(\%data);
        return ok($result);
    }

    # 404
    return err(404, 'Ruta no encontrada');
}

# ═══════════════════════════════════════════════════════════════════════════════
# PDF / HTML REPORT
# ═══════════════════════════════════════════════════════════════════════════════
sub render_report_html {
    my ($r) = @_;
    my $id       = $r->{id};
    my $cl       = esc($r->{client});
    my $addr     = esc($r->{address});
    my $svc      = esc($r->{service_type});
    my $date     = esc($r->{report_date}//'');
    my $sup      = esc($r->{supervisor_name}//'');
    my $desc     = esc($r->{vulnerability_description}//'');
    my $rec      = esc($r->{recommendations}//'');
    my $prob     = $r->{probability}//1;
    my $imp      = $r->{impact}//1;
    my $score    = $r->{risk_score}//($prob*$imp);
    my $level    = $r->{risk_level}//'Bajo';

    my %level_color = (
        'Crítico' => '#dc2626', 'Alto' => '#d97706',
        'Medio'   => '#2563eb', 'Bajo' => '#16a34a',
    );
    my $color = $level_color{$level} // '#64748b';

    # Checklist items
    my $cl_html = '';
    if (ref $r->{checklist} eq 'HASH') {
        my %labels = (
            iluminacion => 'Iluminación', perimetro => 'Perímetro',
            accesos => 'Accesos', camaras => 'CCTV',
            cerraduras => 'Cerraduras', guardias => 'Guardias',
            comunicaciones => 'Comunicaciones', materiales => 'Materiales',
            emergencias => 'Emergencias', vehiculos => 'Vehicular',
        );
        my @items = grep { $r->{checklist}{$_} } keys %labels;
        if (@items) {
            $cl_html = '<div class="section"><h3>Áreas Afectadas</h3><div class="tags">'
                . join('', map { "<span class='tag'>$labels{$_}</span>" } @items)
                . '</div></div>';
        }
    }

    # Fotos
    my $photos_html = '';
    if (ref $r->{images} eq 'ARRAY' && @{$r->{images}}) {
        my @imgs = map { "<img src='/uploads/$_->{filename}' alt='Evidencia'>" } @{$r->{images}};
        $photos_html = '<div class="section"><h3>Evidencia Fotográfica</h3><div class="photos">'
            . join('', @imgs) . '</div></div>';
    }

    my $num = sprintf('%05d', $id);

    return <<HTML;
<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Informe de Vulnerabilidad N° $num</title>
<style>
  * { box-sizing:border-box; margin:0; padding:0; }
  body { font-family: Arial, Helvetica, sans-serif; font-size: 13px; color: #1e293b; background: #f8fafc; }
  .page { max-width: 800px; margin: 0 auto; background: #fff; }
  .header { background: linear-gradient(90deg,#5A1010,#7B1A1A); color: #fff; padding: 20px 32px; display:flex; justify-content:space-between; align-items:center; }
  .header h1 { font-size: 20px; font-weight: 700; letter-spacing:.5px; }
  .header .meta { text-align:right; font-size:11px; color:#f0a0a0; }
  .risk-banner { padding: 14px 32px; color:#fff; background: $color; display:flex; align-items:center; gap:16px; }
  .risk-score  { font-size: 36px; font-weight:900; min-width:50px; }
  .risk-info h2 { font-size:18px; font-weight:800; letter-spacing:1px; }
  .risk-info p  { font-size:11px; opacity:.85; margin-top:2px; }
  .body { padding: 24px 32px; }
  .section { margin-bottom: 20px; }
  .section h3 { font-size:11px; font-weight:700; color:#1a2744; letter-spacing:1px; text-transform:uppercase;
                border-bottom: 2px solid #1a2744; padding-bottom:4px; margin-bottom:10px; }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  table td { padding: 7px 10px; border-bottom: 1px solid #e2e8f0; }
  table td:first-child { font-weight:600; color:#475569; width:160px; background:#f8fafc; }
  .desc { line-height:1.7; white-space:pre-wrap; font-size:13px; }
  .tags { display:flex; flex-wrap:wrap; gap:6px; }
  .tag { background:#dbeafe; color:#1d4ed8; padding:3px 10px; border-radius:20px; font-size:11px; font-weight:600; }
  .photos { display:grid; grid-template-columns: repeat(2,1fr); gap:10px; margin-top:8px; }
  .photos img { width:100%; border-radius:6px; border:1px solid #e2e8f0; object-fit:cover; max-height:200px; }
  .footer { background:linear-gradient(90deg,#5A1010,#7B1A1A); color:#f0a0a0; padding:10px 32px; font-size:10px; display:flex; justify-content:space-between; }
  .print-btn { position:fixed; bottom:24px; right:24px; background:#1a2744; color:#fff;
               border:none; padding:12px 22px; border-radius:999px; font-size:14px;
               font-weight:700; cursor:pointer; box-shadow:0 4px 16px rgba(0,0,0,.25); z-index:9999; }
  \@media print {
    .print-btn { display:none; }
    body { background:#fff; }
    .page { max-width:100%; }
    .photos img { max-height:180px; }
  }
</style>
</head>
<body>
<button class="print-btn" onclick="window.print()">🖨 Imprimir / PDF</button>
<div class="page">

  <div class="header">
    <div>
      <img src="/img/logo.png" alt="SAB-5" style="height:42px;filter:brightness(0) invert(1);margin-bottom:6px;display:block;">
      <h1>INFORME DE VULNERABILIDAD</h1>
    </div>
    <div class="meta">
      <div>N° $num</div>
      <div>$date</div>
    </div>
  </div>

  <div class="risk-banner">
    <div class="risk-score">$score</div>
    <div class="risk-info">
      <h2>RIESGO $level</h2>
      <p>Probabilidad $prob/5 · Impacto $imp/5 · Puntuación $score/25</p>
    </div>
  </div>

  <div class="body">

    <div class="section">
      <h3>Datos del Servicio</h3>
      <table>
        <tr><td>Cliente</td><td>$cl</td></tr>
        <tr><td>Dirección</td><td>$addr</td></tr>
        <tr><td>Tipo de servicio</td><td>$svc</td></tr>
        <tr><td>Fecha y hora</td><td>$date</td></tr>
        <tr><td>Supervisor</td><td>$sup</td></tr>
      </table>
    </div>

    $cl_html

    <div class="section">
      <h3>Vulnerabilidades Detectadas</h3>
      <p class="desc">$desc</p>
    </div>

    <div class="section">
      <h3>Recomendaciones</h3>
      <p class="desc">$rec</p>
    </div>

    $photos_html

  </div>

  <div class="footer">
    <span>SecureReport · Informe N° $num · Supervisor: $sup</span>
    <span>Generado: ${\(scalar localtime)}</span>
  </div>

</div>
</body>
</html>
HTML
}

# ═══════════════════════════════════════════════════════════════════════════════
# ANTHROPIC API
# ═══════════════════════════════════════════════════════════════════════════════
sub call_claude_api {
    my ($d) = @_;
    my %area_labels = (
        iluminacion => 'Iluminación perimetral e interior',
        perimetro   => 'Perímetro y cerco de seguridad',
        accesos     => 'Control de accesos',
        camaras     => 'Sistema de videovigilancia (CCTV)',
        cerraduras  => 'Cerraduras y elementos de cierre',
        guardias    => 'Posicionamiento del personal de guardia',
        comunicaciones => 'Sistemas de comunicación y alarmas',
        materiales  => 'Almacenamiento de materiales peligrosos',
        emergencias => 'Salidas de emergencia y evacuación',
        vehiculos   => 'Control de acceso vehicular',
    );
    my %sev_labels = (1=>'leve',2=>'moderada',3=>'significativa',4=>'grave');

    my $areas = ref($d->{areas}) eq 'HASH' ? $d->{areas} : {};
    my @affected;
    for my $k (keys %$areas) {
        my $v = $areas->{$k};
        next unless ref $v eq 'HASH' && $v->{affected};
        my $label = $area_labels{$k} // $k;
        my $sev   = $sev_labels{$v->{severity}//2} // 'moderada';
        my $text  = $v->{findings} ? qq("$v->{findings}") : 'Sin observaciones adicionales';
        push @affected, "• $label (gravedad $sev): $text";
    }

    my $affected_text = @affected ? join("\n", @affected) : 'No se detectaron vulnerabilidades significativas.';
    my $client   = $d->{client}       // '';
    my $address  = $d->{address}      // '';
    my $svc      = $d->{service_type} // '';
    my $sname    = $d->{supervisor_name} // '';
    my $prob     = $d->{probability}  // 3;
    my $imp      = $d->{impact}       // 3;
    my $score    = $d->{risk_score}   // ($prob*$imp);
    my $level    = $d->{risk_level}   // risk_level($score);
    my $notes    = $d->{extra_notes}  // '';

    my $prompt = <<PROMPT;
Sos un consultor experto en seguridad privada y física con más de 15 años de experiencia. Redactá un informe profesional de vulnerabilidades con los siguientes datos de campo:

SERVICIO: $client | $address | $svc | Supervisor: $sname
RIESGO: Probabilidad $prob/5 · Impacto $imp/5 · Puntuación $score/25 · Nivel: $level

ÁREAS CON VULNERABILIDADES:
$affected_text
${\($notes ? "NOTAS: $notes" : '')}

Respondé SOLO con un JSON válido sin markdown:
{"descripcion":"[4 párrafos profesionales: introducción del estado general, detalle de cada vulnerabilidad, impacto combinado, síntesis. Sin listas, prosa fluida.]","recomendaciones":"[Lista numerada con PRIORIDAD (INMEDIATA/CORTO/MEDIANO PLAZO), acción concreta y objetivo. Mínimo 5 puntos. Para riesgo Alto/Crítico, al menos 2 medidas inmediatas.]"}
PROMPT

    my $body = encode_json({
        model      => 'claude-haiku-4-5-20251001',
        max_tokens => 2000,
        messages   => [{ role => 'user', content => $prompt }],
    });

    my $http = HTTP::Tiny->new(timeout => 30, verify_SSL => 0);
    my $resp = $http->request('POST', 'https://api.anthropic.com/v1/messages', {
        content => $body,
        headers => {
            'Content-Type'      => 'application/json',
            'x-api-key'         => $AI_KEY,
            'anthropic-version' => '2023-06-01',
        },
    });

    unless ($resp->{success}) {
        return { descripcion => '', recomendaciones => '',
                 error => "Error API: $resp->{status}" };
    }

    my $data;
    eval { $data = decode_json($resp->{content}); };
    if ($@) {
        my $preview = substr($resp->{content} // '', 0, 300);
        return { descripcion => '', recomendaciones => '', error => "Parse error: $preview" };
    }

    # Error de API (ej: créditos insuficientes)
    if ($data->{error}) {
        return { descripcion => '', recomendaciones => '',
                 error => $data->{error}{message} // 'Error de API Anthropic' };
    }

    my $text = $data->{content}[0]{text} // '';

    # Quitar bloques markdown ```json ... ```
    $text =~ s/^```(?:json)?\s*//s;
    $text =~ s/\s*```\s*$//s;
    $text =~ s/^\s+|\s+$//gs;

    # Extraer el objeto JSON del texto
    my ($json_str) = $text =~ /(\{[\s\S]*\})/s;
    $json_str //= $text;

    my $parsed;
    eval { $parsed = decode_json(encode_utf8($json_str)); };
    if ($@) {
        return { descripcion => $text, recomendaciones => '' };
    }

    return {
        descripcion     => $parsed->{descripcion}     // $text,
        recomendaciones => $parsed->{recomendaciones} // '',
    };
}

# ═══════════════════════════════════════════════════════════════════════════════
# HELPERS
# ═══════════════════════════════════════════════════════════════════════════════
sub risk_level {
    my $s = shift;
    return 'Bajo'   if $s <= 5;
    return 'Medio'  if $s <= 10;
    return 'Alto'   if $s <= 15;
    return 'Crítico';
}

sub now       { strftime('%Y-%m-%d %H:%M:%S', localtime) }
sub now_short { strftime('%Y-%m-%dT%H:%M', localtime) }

sub esc {
    my $s = shift // '';
    $s =~ s/&/&amp;/g; $s =~ s/</&lt;/g; $s =~ s/>/&gt;/g;
    $s =~ s/"/&quot;/g;
    return $s;
}

sub _new_password {
    my $pass = shift;
    my $salt = random_hex(16);
    return ($salt, sha256_hex($salt . $pass));
}

sub check_password {
    my ($plain, $stored) = @_;
    my ($salt, $hash) = split /:/, $stored, 2;
    return sha256_hex($salt . $plain) eq $hash;
}

sub random_hex {
    my $n = shift // 16;
    return join('', map { sprintf('%02x', int rand 256) } 1..$n);
}

# JWT-like token: base64(id:role:expiry).hmac
sub make_token {
    my $u       = shift;
    my $expiry  = int(time()) + 43200; # 12h
    my $payload = encode_base64("$u->{id}:$u->{role}:$expiry", '');
    my $sig     = hmac_sha256_hex($payload, $SECRET);
    return "$payload.$sig";
}

sub verify_token {
    my $token = shift // '';
    return undef unless $token =~ /^([A-Za-z0-9+\/=]+)\.([0-9a-f]+)$/;
    my ($payload, $sig) = ($1, $2);
    return undef unless hmac_sha256_hex($payload, $SECRET) eq $sig;
    my $decoded = decode_base64($payload);
    my ($id, $role, $expiry) = split /:/, $decoded, 3;
    return undef unless $id && $role && $expiry;
    return undef if $expiry < time();
    my $users = read_json("$DATA_DIR/users.json");
    my ($u) = grep { $_->{id} == $id && $_->{active} } @$users;
    return undef unless $u;
    return { id => $u->{id}+0, username => $u->{username},
             full_name => $u->{full_name}, role => $u->{role} };
}

sub pub_user {
    my $u = shift;
    return { id => $u->{id}+0, username => $u->{username},
             full_name => $u->{full_name}, role => $u->{role},
             active => $u->{active}+0, created_at => $u->{created_at} };
}

sub read_json {
    my $f = shift;
    return [] unless -f $f;
    open my $fh, '<:utf8', $f or return [];
    local $/; my $raw = <$fh>; close $fh;
    my $data; eval { $data = decode_json($raw); };
    return $@ ? [] : $data;
}

sub write_json {
    my ($f, $data) = @_;
    open my $fh, '>:utf8', $f or die "No se pudo escribir $f: $!";
    print $fh encode_json($data);
    close $fh;
}

sub ok {
    my ($data, $status) = @_;
    $status //= 200;
    my $res = HTTP::Response->new($status);
    $res->header('Content-Type' => 'application/json; charset=utf-8');
    add_cors($res);
    $res->content(encode_utf8(encode_json($data)));
    return $res;
}

sub err {
    my ($status, $msg) = @_;
    return ok({ error => $msg }, $status);
}

sub add_cors {
    my $r = shift;
    $r->header('Access-Control-Allow-Origin'  => '*');
    $r->header('Access-Control-Allow-Methods' => 'GET,POST,PUT,DELETE,OPTIONS');
    $r->header('Access-Control-Allow-Headers' => 'Authorization,Content-Type');
}

# Servir archivos estáticos
sub serve_file {
    my $path = shift;

    # Seguridad: bloquear path traversal
    $path =~ s/\.\.//g;

    # Normalizar a separadores del SO
    $path =~ s{/}{\\}g if $^O eq 'MSWin32';

    # Si el archivo no existe servir index.html (SPA fallback)
    unless (-f $path) {
        $path = $PUBLIC . '/public/index.html';
        $path = $PUBLIC . '\\public\\index.html' if $^O eq 'MSWin32';
        # $PUBLIC ya incluye /public, así que solo agregamos index.html
        $path = "$PUBLIC/index.html";
    }

    open my $fh, '<:raw', $path or do {
        my $r = HTTP::Response->new(404, 'Not Found');
        $r->header('Content-Type' => 'text/plain');
        $r->content('Not found');
        return $r;
    };
    local $/;
    my $body = <$fh>;
    close $fh;

    # Detectar extensión sin punto, insensible a mayúsculas
    my ($ext) = $path =~ /\.([^.\/\\]+)$/;
    my $ct = $MIME{ lc($ext // '') } // 'application/octet-stream';

    my $res = HTTP::Response->new(200, 'OK');
    $res->header('Content-Type'   => $ct);
    $res->header('Content-Length' => length($body));
    $res->content($body);
    return $res;
}

# Parsear multipart/form-data
sub parse_multipart {
    my ($ct, $body) = @_;
    my ($boundary) = $ct =~ /boundary=["']?([^"';\s]+)["']?/i;
    return ({}, []) unless $boundary;

    my %fields;
    my @files;
    my @parts = split(/\r?\n--\Q$boundary\E/, $body);

    for my $part (@parts) {
        $part =~ s/^[\r\n]+//;
        next if $part =~ /^--/ || $part =~ /^\s*$/;
        my ($head, $content) = $part =~ /^(.*?)\r?\n\r?\n(.*)/s;
        next unless defined $head && defined $content;
        $content =~ s/\r?\n$//;

        my ($name)     = $head =~ /name="([^"]+)"/i;
        my ($filename) = $head =~ /filename="([^"]*)"/i;
        next unless defined $name;

        if (defined $filename && $filename ne '') {
            push @files, { name => $name, filename => $filename,
                           value => undef, data => $content };
        } else {
            $fields{$name} = $content;
        }
    }
    return (\%fields, \@files);
}

# Parsear query string o urlencoded body
sub parse_qs {
    my $str = shift // '';
    my %out;
    for my $pair (split /&/, $str) {
        my ($k, $v) = split /=/, $pair, 2;
        next unless defined $k;
        $k =~ s/\+/ /g; $k =~ s/%([0-9A-Fa-f]{2})/chr(hex($1))/ge;
        $v //= '';
        $v =~ s/\+/ /g; $v =~ s/%([0-9A-Fa-f]{2})/chr(hex($1))/ge;
        $out{$k} = $v;
    }
    return \%out;
}
