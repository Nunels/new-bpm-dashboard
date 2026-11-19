package it.sim.temporal.app;

import java.nio.file.Path;

import io.temporal.client.WorkflowClient;
import io.temporal.client.WorkflowClientOptions;
import io.temporal.serviceclient.WorkflowServiceStubs;
import io.temporal.serviceclient.WorkflowServiceStubsOptions;

/** Configurazione da variabili d'ambiente, condivisa da worker e CLI. */
record Settings(String address, String namespace, String taskQueue, Path definitionsDir) {

    static final String DEFAULT_TASK_QUEUE = "offer-interpreter";

    static Settings fromEnv() {
        return new Settings(env("TEMPORAL_ADDRESS", "127.0.0.1:7233"), env("TEMPORAL_NAMESPACE", "default"),
                env("TASK_QUEUE", DEFAULT_TASK_QUEUE), Path.of(env("DEFINITIONS_DIR", "./definitions")));
    }

    private static String env(String name, String fallback) {
        String v = System.getenv(name);
        return v == null || v.isBlank() ? fallback : v;
    }

    WorkflowClient client() {
        WorkflowServiceStubs service = WorkflowServiceStubs.newServiceStubs(WorkflowServiceStubsOptions.newBuilder().setTarget(address).build());
        return WorkflowClient.newInstance(service, WorkflowClientOptions.newBuilder().setNamespace(namespace).build());
    }
}
