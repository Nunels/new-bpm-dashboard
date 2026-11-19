package it.sim.temporal.app;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.UUID;

import io.temporal.client.WorkflowClient;
import io.temporal.client.WorkflowOptions;
import io.temporal.client.WorkflowStub;
import it.sim.temporal.workflow.OfferInterpreterWorkflow;
import it.sim.temporal.workflow.RunRequest;
import it.sim.temporal.workflow.RunResult;

/**
 * Riga di comando verso un server Temporal (stesse variabili d'ambiente del worker).
 * <pre>
 * start   &lt;namespace&gt; &lt;name&gt; &lt;version|latest&gt; &lt;input.json&gt; [workflowId]   avvia una pratica e attende l'esito
 * event   &lt;workflowId&gt; &lt;event.json&gt;                                   invia un evento (es. callback del ticket)
 * context &lt;workflowId&gt;                                                legge $context e il task corrente
 * </pre>
 */
public final class Cli {

    private Cli() {
    }

    public static void main(String[] args) throws Exception {
        if (args.length == 0) {
            usage();
            return;
        }
        Settings s = Settings.fromEnv();
        WorkflowClient client = s.client();
        switch (args[0]) {
            case "start" -> {
                String id = args.length > 5 ? args[5] : "pratica-" + UUID.randomUUID();
                OfferInterpreterWorkflow wf = client.newWorkflowStub(OfferInterpreterWorkflow.class,
                        WorkflowOptions.newBuilder().setTaskQueue(s.taskQueue()).setWorkflowId(id).build());
                RunRequest req = new RunRequest(args[1], args[2], "latest".equals(args[3]) ? null : args[3], Files.readString(Path.of(args[4])));
                System.out.println("workflowId=" + id);
                RunResult r = wf.run(req);
                OfferOutcome o = OfferOutcome.of(r);
                System.out.println("stato=" + o.status() + " definizione=" + r.definition);
                System.out.println("output=" + r.outputJson);
                if (r.errorJson != null) System.out.println("errore=" + r.errorJson);
            }
            case "event" -> {
                WorkflowStub stub = client.newUntypedWorkflowStub(args[1]);
                stub.signal("event", Files.readString(Path.of(args[2])));
                System.out.println("evento inviato a " + args[1]);
            }
            case "context" -> {
                OfferInterpreterWorkflow wf = client.newWorkflowStub(OfferInterpreterWorkflow.class, args[1]);
                System.out.println("task=" + wf.currentTask());
                System.out.println("context=" + wf.context());
            }
            default -> usage();
        }
        System.exit(0);
    }

    private static void usage() {
        System.out.println("uso: start <namespace> <name> <version|latest> <input.json> [workflowId] | event <workflowId> <event.json> | context <workflowId>");
    }
}
