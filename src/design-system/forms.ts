"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useTransition, type FormEvent } from "react";
import { useForm, type FieldValues, type Resolver, type UseFormProps, type UseFormReturn } from "react-hook-form";
import type { z } from "zod";

export function useZodForm<TFieldValues extends FieldValues>(
  schema: z.ZodType<TFieldValues, FieldValues>,
  options?: UseFormProps<TFieldValues>
): UseFormReturn<TFieldValues> {
  return useForm<TFieldValues>({
    mode: "onBlur",
    resolver: zodResolver(schema) as Resolver<TFieldValues>,
    ...options
  });
}

export function useServerActionValidation<TFieldValues extends FieldValues>(
  form: UseFormReturn<TFieldValues>,
  action: (payload: FormData) => void
): (event: FormEvent<HTMLFormElement>) => void {
  const [, startTransition] = useTransition();

  return (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formElement = event.currentTarget;
    const formData = new FormData(formElement);

    void form.trigger().then((valid) => {
      if (!valid) {
        return;
      }

      startTransition(() => {
        action(formData);
      });
    });
  };
}
