# مهمة الترحيل: تنشئ الأدوار والامتدادات (bootstrap) ثم تطبّق الترحيلات الجديدة فقط، ثم تخرج.
FROM postgres:16-bookworm
COPY bootstrap.sql migrate.sh deploy.sh /db/
COPY migrations /db/migrations
RUN chmod +x /db/migrate.sh /db/deploy.sh
ENTRYPOINT ["/db/deploy.sh"]
