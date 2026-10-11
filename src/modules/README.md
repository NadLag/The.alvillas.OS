# Modules

Business contexts live here using the handbook boundary:

`ui -> application -> domain -> infrastructure`

Routes and server actions validate input, call `authorize`, then delegate to application services. Repositories are the only layer that talks to Prisma.
