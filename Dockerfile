# BPM AI Offer Designer (backend offer-agent + dashboard) per Render.
# Il contesto di build è la cartella "prototipi": il backend dipende da temporal-offer-interpreter e include il codice di offer-dashboard.

FROM maven:3.9-eclipse-temurin-17 AS build
WORKDIR /src

# 1) libreria usata dal backend per validare il perimetro del DSL
COPY temporal-offer-interpreter/pom.xml temporal-offer-interpreter/pom.xml
COPY temporal-offer-interpreter/src/main temporal-offer-interpreter/src/main
RUN mvn -B -q -f temporal-offer-interpreter/pom.xml -Dmaven.test.skip=true install

# 2) dashboard (copiata nel jar a build time) e backend
COPY offer-dashboard offer-dashboard
COPY offer-agent/pom.xml offer-agent/pom.xml
COPY offer-agent/src/main offer-agent/src/main
RUN mvn -B -q -f offer-agent/pom.xml -Dmaven.test.skip=true package

FROM eclipse-temurin:17-jre
RUN useradd --system --uid 10001 --create-home app
# GraalJS (esegue il JavaScript della dashboard) estrae le sue risorse in una cache sotto HOME: la home deve esistere ed essere scrivibile.
WORKDIR /app
COPY --from=build /src/offer-agent/target/quarkus-app/ ./
USER app

# Render imposta PORT (default 10000). La chiave del modello va in GEMINI_API_KEY, mai nell'immagine.
ENV PORT=10000 \
    HOME=/home/app \
    JAVA_OPTS="-XX:MaxRAMPercentage=75 -XX:+UseSerialGC"
EXPOSE 10000
ENTRYPOINT ["sh", "-c", "exec java $JAVA_OPTS -jar quarkus-run.jar"]
