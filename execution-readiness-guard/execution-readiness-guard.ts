'use strict';

type Input = {
  route: string;
  state: any;
};

type Output = {
  ok: boolean;
  route: string;
  readiness: 'healthy' | 'degraded' | 'blocked';
  eligible: boolean;
  reason: string;
};

function evaluateReadiness(input: Input): Output {
  const route = input?.route;
  const state = input?.state || {};

  const routeOperator = state?.routeOperatorByRoute?.[route] || null;
  const routeHealth = state?.routeHealthByRoute?.[route] || null;
  const protocol = routeOperator?.protocol;
  const protocolHealth = state?.protocolHealthByProtocol?.[protocol] || null;
  const routeScore = state?.routeScoreByRoute?.[route] || null;

  // BLOCK conditions
  if (!routeOperator || routeOperator?.decision === 'BLOCK') {
    return {
      ok: true,
      route,
      readiness: 'blocked',
      eligible: false,
      reason: 'ROUTE_OPERATOR_BLOCKED'
    };
  }

  if (routeHealth?.status === 'blocked') {
    return {
      ok: true,
      route,
      readiness: 'blocked',
      eligible: false,
      reason: routeHealth?.reason || 'ROUTE_BLOCKED'
    };
  }

  if (protocolHealth?.status === 'blocked') {
    return {
      ok: true,
      route,
      readiness: 'blocked',
      eligible: false,
      reason: protocolHealth?.reason || 'PROTOCOL_BLOCKED'
    };
  }

  // DEGRADED condition
  if (routeScore?.status === 'degraded') {
    return {
      ok: true,
      route,
      readiness: 'degraded',
      eligible: false,
      reason: routeScore?.reason || 'ROUTE_UNDERPERFORMING'
    };
  }

  // HEALTHY
  return {
    ok: true,
    route,
    readiness: 'healthy',
    eligible: true,
    reason: 'READY'
  };
}

// CLI execution
async function main() {
  try {
    let input = '';

    process.stdin.on('data', chunk => {
      input += chunk;
    });

    process.stdin.on('end', () => {
      const parsed = JSON.parse(input);
      const result = evaluateReadiness(parsed);
      console.log(JSON.stringify(result));
    });
  } catch (err) {
    console.error(JSON.stringify({
      ok: false,
      error: 'INVALID_INPUT'
    }));
  }
}

main();
