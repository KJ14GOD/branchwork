$ErrorActionPreference = 'Stop'
# The hosted image supplies PostgreSQL. This isolated cluster uses only fixture data.
if (-not $env:PGBIN) { throw 'The Windows runner has no PGBIN PostgreSQL installation.' }
$data = Join-Path $env:RUNNER_TEMP 'novus-postgres'
& "$env:PGBIN/initdb.exe" -D $data -U novus --auth=trust --encoding=UTF8 --locale=C
if ($LASTEXITCODE -ne 0) { throw 'PostgreSQL initialization failed.' }
& "$env:PGBIN/pg_ctl.exe" -D $data -l "$env:RUNNER_TEMP/novus-postgres.log" -o '-p 5433 -h 127.0.0.1' -w start
if ($LASTEXITCODE -ne 0) { throw 'PostgreSQL startup failed.' }
& "$env:PGBIN/createdb.exe" -h 127.0.0.1 -p 5433 -U novus novus
if ($LASTEXITCODE -ne 0) { throw 'Test database creation failed.' }
