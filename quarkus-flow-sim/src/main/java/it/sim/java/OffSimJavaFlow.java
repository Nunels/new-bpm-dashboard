package it.sim.java;

import jakarta.enterprise.context.ApplicationScoped;

import io.quarkiverse.flow.Flow;
import io.serverlessworkflow.api.types.Workflow;

/** Variante B dell'offerta di prova: stesso Execution Plan del YAML, eseguito da funzioni Java. */
@ApplicationScoped
public class OffSimJavaFlow extends Flow {
    @Override
    public Workflow descriptor() {
        return PlanFlow.build("OFF_SIM", "offer-off-sim");
    }
}
