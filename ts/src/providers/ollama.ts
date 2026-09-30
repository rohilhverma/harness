import { Ollama } from "ollama";
import type {
  ModelProvider,
  ModelRequest,
  ModelResponse,
} from "../interfaces.js";



export class OllamaServer implements ModelProvider<Ollama>{

    address:string
    private readonly client: Ollama

    constructor(address:string){
        this.address=address
        this.client = new Ollama({host: this.address })
    }

    async createClient(): Promise<Ollama | null>{
        const healthCheck = await this.serverStatus()
        if (healthCheck){
            return this.client
        }
        return null

    }

    async generate(request: ModelRequest): Promise<ModelResponse> {
        if (!request.model) {
            throw new Error("A model is required");
        }

        if (request.tools) {
            throw new Error("Tool support is not implemented yet");
        }

        const messages = request.messages.map((message) => {
            if (message.role === "tool" || message.toolCalls?.length) {
                throw new Error("Tool support is not implemented yet");
            }

            return {
                role: message.role,
                content: message.content,
            };
        });

        const response = await this.client.chat({
            model: request.model,
            messages,
            stream: false,
            options: { temperature: request.temperature },
        });

        return {
            output: {
                role: "assistant",
                content: response.message.content,
            },
            conclusion: response.done_reason === "length" ? "length" : "success",
        };
    }

    async serverStatus(): Promise<boolean>{
            try {
                const serverHealth = await fetch(`${this.address}/api/version`)
                return serverHealth.ok
            } catch {
                return false
            }

    }

}
