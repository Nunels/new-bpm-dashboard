package it.sim.temporal.workflow;

/** Avvio di un workflow: coordinate della definizione pubblicata e input della pratica (JSON). */
public final class RunRequest {

    public String namespace;
    public String name;
    /** null o "latest" = versione più recente. */
    public String version;
    public String inputJson;

    public RunRequest() {
    }

    public RunRequest(String namespace, String name, String version, String inputJson) {
        this.namespace = namespace;
        this.name = name;
        this.version = version;
        this.inputJson = inputJson;
    }

    public String ref() {
        return namespace + ":" + name + ":" + (version == null ? "latest" : version);
    }
}
