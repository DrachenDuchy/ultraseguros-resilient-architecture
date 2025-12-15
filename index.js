// index.js (Lambda) - UltraSeguros resiliente por niveles
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
} = require("@aws-sdk/lib-dynamodb");

const baseClient = new DynamoDBClient({});
const dynamo = DynamoDBDocumentClient.from(baseClient);

// Si quieres, puedes poner TABLE_NAME como env var en Lambda
const TABLE_NAME = process.env.TABLE_NAME || "system_state";
const SERVICE_ID = process.env.SERVICE_ID || "core-system";

// Umbrales del reto (según tu enunciado)
const ERRORS_TO_LVL2 = 5;   // Nivel 1 -> 2
const ERRORS_TO_LVL3 = 10;  // Nivel 2 -> 3
const HEALTHY_TO_LVL2 = 10; // Nivel 3 -> 2
const HEALTHY_TO_LVL1 = 20; // Nivel 2 -> 1

async function getState() {
  const result = await dynamo.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: { serviceId: SERVICE_ID },
    })
  );

  if (!result.Item) {
    return {
      serviceId: SERVICE_ID,
      currentLevel: 1,
      consecutiveErrors: 0,
      consecutiveHealthy: 0,
    };
  }

  // Compatibilidad por si venías guardando otros campos antes
  return {
    serviceId: SERVICE_ID,
    currentLevel: result.Item.currentLevel ?? 1,
    consecutiveErrors: result.Item.consecutiveErrors ?? 0,
    consecutiveHealthy: result.Item.consecutiveHealthy ?? 0,
  };
}

async function saveState(state) {
  await dynamo.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: state,
    })
  );
}

function buildResponse(level, ok) {
  if (level === 1) {
    return ok
      ? { statusCode: 200, message: "Nivel 1: OK" }
      : { statusCode: 500, message: "Error en Nivel 1" };
  }
  if (level === 2) {
    return ok
      ? { statusCode: 200, message: "Nivel 2: Operación Limitada" }
      : { statusCode: 500, message: "Error en Nivel 2" };
  }
  // Nivel 3
  return ok
    ? { statusCode: 200, message: "Nivel 3: Operación al mínimo" }
    : {
        statusCode: 500,
        message: "Nivel 3: Sistema bajo mantenimiento, intente más tarde",
      };
}

// Lee body JSON (API Gateway puede entregar string o ya parseado)
function parseBody(event) {
  try {
    if (!event) return {};
    if (event.body == null) return {};
    if (typeof event.body === "string") return JSON.parse(event.body);
    return event.body; // ya viene como objeto
  } catch {
    return {};
  }
}

exports.handler = async (event) => {
  const now = new Date().toISOString();

  // 0) Leer el error que manda K6
  const payload = parseBody(event);
  const requestedError = payload?.error === true;

  // 1) Leer estado
  const state = await getState();
  let { currentLevel, consecutiveErrors, consecutiveHealthy } = state;

  const prevLevel = currentLevel;

  // 2) Determinar si esta request cuenta como OK o ERROR
  // Regla: si K6 manda error=true => ERROR controlado
  const ok = !requestedError;

  if (ok) {
    consecutiveHealthy += 1;
    consecutiveErrors = 0;
  } else {
    consecutiveErrors += 1;
    consecutiveHealthy = 0;
  }

  // 3) Reglas de degradación
  if (currentLevel === 1 && consecutiveErrors >= ERRORS_TO_LVL2) {
    currentLevel = 2;
    consecutiveErrors = 0;
    consecutiveHealthy = 0;
  } else if (currentLevel === 2 && consecutiveErrors >= ERRORS_TO_LVL3) {
    currentLevel = 3;
    consecutiveErrors = 0;
    consecutiveHealthy = 0;
  }

  // 4) Reglas de recuperación
  if (currentLevel === 3 && consecutiveHealthy >= HEALTHY_TO_LVL2) {
    currentLevel = 2;
    consecutiveErrors = 0;
    consecutiveHealthy = 0;
  } else if (currentLevel === 2 && consecutiveHealthy >= HEALTHY_TO_LVL1) {
    currentLevel = 1;
    consecutiveErrors = 0;
    consecutiveHealthy = 0;
  }

  // 5) Construir respuesta según el nivel (y si ok/error)
  const result = buildResponse(currentLevel, ok);

  // 6) Guardar estado
  await saveState({
    serviceId: SERVICE_ID,
    currentLevel,
    consecutiveErrors,
    consecutiveHealthy,
  });

  // 7) Logs (para evidencia)
  if (prevLevel !== currentLevel) {
    console.log(
      JSON.stringify({
        time: now,
        eventType: "LEVEL_TRANSITION",
        from: prevLevel,
        to: currentLevel,
      })
    );
  }

  console.log(
    JSON.stringify({
      time: now,
      eventType: "REQUEST_RESULT",
      requestedError,
      level: currentLevel,
      consecutiveErrors,
      consecutiveHealthy,
      statusCode: result.statusCode,
      message: result.message,
    })
  );

  // 8) Respuesta al cliente
  return {
    statusCode: result.statusCode,
    body: JSON.stringify({
      time: now,
      level: currentLevel,
      message: result.message,
    }),
  };
};
