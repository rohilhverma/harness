
# C++ Notes

## How C++ Works

C++ is a compiled language: source code is processed by a compiler. Each source file is compiled into an **object file**, and the **linker** then combines all the object files into one executable file.

```
source files (.cpp) → compiler → object files (.o) → linker → executable
```

The executable you create is **not portable**: it only runs on the kind of system it was built for. What you *can* port is the source code, which you then compile yourself on the new system.

## Entities

Entities are just the general elements of a program:

- **Core language features:** built-in types, loops, etc.
- **Standard library components:** containers of data, I/O operations, etc.

C++ is **statically typed**: the type of every entity must be known to the compiler at the point where it's used.

---

## Constants: `const`, `constexpr`, and `consteval`

C++ provides two main forms of immutability:

- `const`: The value cannot be changed after initialization, but it may be calculated at runtime.
- `constexpr`: The value cannot be changed and must be calculable by the compiler at compile time.

A `constexpr` function can run at compile time when given compile-time constants, or at runtime when given runtime values:

```cpp
constexpr double square(double x) {
    return x * x;
}

constexpr double a = square(5);   // Compile-time evaluation
const double b = square(input);   // Runtime evaluation (input is only known at runtime)
```

A `consteval` function must always be evaluated at compile time:

```cpp
consteval double cube(double x) {
    return x * x * x;
}

constexpr double c = cube(3);     // OK: 3 is known at compile time
// double d = cube(input);        // Error: input is only known at runtime
```

Constant expressions are required in places such as built-in array sizes, case labels, template value arguments, and variables declared `constexpr`.

**Rule of thumb:**

- Use `constexpr` for values and calculations known at compile time.
- Use `const` for runtime values that should not change after initialization.
- Use `consteval` for functions that must only run at compile time.

---

## Input and Output

Use `cout` to write text to the terminal, and `cin` to read input text from the user.

```cpp
#include <iostream>

int main() {
    int age;
    std::cout << "Enter your age: ";
    std::cin >> age;
    std::cout << "You are " << age << " years old\n";
}
```

---

## C++ and the Hardware

C++ maps directly to the hardware. Basic operations, like adding two variables or accessing an array element, translate directly into machine operations.

Memory is thought of as a long sequence of memory locations, where you can place objects and refer to them with pointers.

---

## Types

**Built-in types** are simple types like `int`, `double`, `char`, `bool`, pointers, and arrays. They come with a set of basic operations, and C++ also provides **abstraction mechanisms** for building new types out of them.

**User-defined types** are types you create yourself, built out of the built-in types.

### Structs

A struct is a data structure that groups together the elements it needs.

```cpp
struct Vector {
    double* elem;   // pointer to the elements
    int sz;         // number of elements
};
```

You also need to initialize the struct and point `elem` at an actual array of elements:

```cpp
void vector_init(Vector& v, int s) {
    v.elem = new double[s];   // allocate an array of s doubles
    v.sz = s;
}
```

There's no fundamental difference between a struct and a class. A struct is just a class whose members are **public by default**, while a class's members are **private by default**.

### Classes

```cpp
class Person {
private:
    std::string name;
    int age;

public:
    Person(std::string name, int age)
        : name(name), age(age) {}     // member initializer list

    std::string getName() const {     // const: this function doesn't change the object
        return name;
    }

    void setAge(int newAge) {
        age = newAge;
    }
};
```

You generally put your data members behind `private` and initialize them in the constructor. In the constructor, everything after the `:` is the **member initializer list**. Each member is initialized directly with `()` (e.g. `name(name)`), rather than through something like `self.` in Python.

### Enumerations

You can create simple user-defined types that list a set of named values:

```cpp
enum class Color { red, blue, green };
enum class Traffic_light { green, yellow, red };

Color c = Color::red;
Traffic_light light = Traffic_light::red;
```

Enumerators belong to their own scope, so `red` in `Color` and `red` in `Traffic_light` are different values.

Enums represent a small set of integer values, but give them readable names, which makes the code easier to read.

### Unions

A union is a struct where all the members are allocated at the same address. That means:

- It only holds **one member at a time**.
- It only takes up as much space as its **largest member**.

This makes it a nice way of saving space.

```cpp
union Value {
    Node* p;
    int i;
};
```

A union doesn't keep track of which member it currently holds, so there's a risk of type mismatch (e.g. storing `i` and then reading `p`). The general practice is to keep a separate **tag** that records which type is currently stored. To make this safe, you usually put the tag and the union inside a class and only expose safe methods, so outside code can't mess with the tag and the union.

> **Tip:** The standard library's `std::variant` does this tag bookkeeping for you and is usually preferred over a raw union.

---

## Modularity

Any C++ program is built out of lots of separately developed components, like functions, user-defined types, etc.

### Separate Compilation

C++ follows a **separate compilation** strategy, where user code generally only needs to see the declarations of the types and functions it uses.

Traditionally, this is done through **header files (`.h`)**, which contain declarations and are included with `#include` when needed. The corresponding implementations are usually placed in `.cpp` files, which are compiled separately and later combined by the linker.

C++20 also introduces **modules**, which provide another way to separate and share code. Modules are compiled separately and can be brought into another file using `import`. Only declarations explicitly marked with `export` are made available to code that imports the module.

### Header Files

Let's say you write a header file, `Vector.h`:

```cpp
class Vector {
public:
    Vector(int s);
    double& operator[](int i);
    int size();
private:
    double* elem;   // elem points to an array of sz doubles
    int sz;
};
```

You can now use `#include "Vector.h"` to access this interface. The header doesn't show you any details about the implementation, which lives in another file, `Vector.cpp`. Each file is compiled separately, and the linker connects the pieces.

### Modules

You can also export the class from a module and `import` it into another file:

```cpp
// Vector module file
export module Vector;

export class Vector {
    // ... same as above
};
```

```cpp
// user.cpp
import Vector;
```

### Headers vs. Modules

Both do the job of exposing an interface, but they work differently:

- **Headers:** `#include` copies the header's text into every file that includes it, so the same declarations get compiled again in each of those files.
- **Modules:** A module is compiled only once. You choose exactly what to expose with `export`, and then any file can `import` it.

### Namespaces

Namespaces are a way of saying that certain declarations belong together, and they also prevent names from clashing with each other. You access a name defined in a namespace by prefixing it with the namespace's name (e.g. `My_code::main`).

```cpp
namespace My_code {
    class complex {
        // ...
    };
    complex sqrt(complex);
    // ...
    int main();
}

int My_code::main()
{
    complex z {1, 2};
    auto z2 = sqrt(z);
    std::cout << '{' << z2.real() << ',' << z2.imag() << "}\n";
    // ...
}

int main()
{
    return My_code::main();
}
```

Putting this code in the custom `My_code` namespace ensures its names (like `complex` and `sqrt`) won't clash with standard library names such as `std::complex` and `std::sqrt`.

---

## Classes in Depth

A class is a user-defined type that represents an entity (a concept) in a program.

### Concrete Classes

Concrete classes behave just like built-in types. Examples include complex numbers, vectors, and strings. They have a real, known representation, and their objects can be placed on the stack, referred to directly or through pointers and references, copied, moved, etc.

Because the representation is known, the compiler knows each object's exact size and layout, so objects can be stored directly. The downside is that if you change the representation, you'll probably have to recompile the code that uses it.

### Containers

A container is an object that holds a collection of elements. The `Vector` class is a container, since every `Vector` object holds a collection of elements.

### Abstract Types

Abstract types completely insulate users from implementation details. The interface is decoupled from the representation, so the user code doesn't know the object's size or layout. Because of this, you can't create them as plain local variables. Instead, you allocate the objects (usually on the heap with `new`) and access them through pointers or references.

```cpp
class Container {
public:
    virtual double& operator[](int) = 0;   // pure virtual function: derived classes must define it
    virtual int size() const = 0;          // const member function: doesn't modify the object
    virtual ~Container() {}                // destructor
};
```

A class with at least one pure virtual function (`= 0`) is an **abstract class**: you can't create an object of it directly, only of classes derived from it.


**Virtual Functions**
Achieves Runtime Polymorphism. It allows you to run the version of code that actually relates to the relevant runtime type. What it does is establish a function in your base class, and if you have a class that inherits another class, you expect to OVERRIDE this very function, with a new implementation. 

```cpp
class Animal {
public:
    virtual void speak() {
        cout << "Animal sound\n";
    }
};

class Dog : public Animal {
public:
    void speak() override {
        cout << "Woof\n";
    }
};
```

So if you ran this object
```cpp
Dog dog;
Animal& animal = dog;

animal.speak();
```
it would "woof". It has a static type of Animal, but is really a Dog object. Virtual kind of forces the runtime to really investigate the underlying object. 


**Abstract Classes** 
A class with at least 1 VIRTUAL FUNCTION. By defining a virtual function inside of a base class, it forces all following classes that implement it to IMPLEMENT this method.

```cpp
#include <iostream>
using namespace std;

class Shape {
public:
    // Pure virtual functions
    virtual double area() = 0;
    virtual void print() = 0;
};

class Rectangle : public Shape {
private:
    double width;
    double height;

public:
    Rectangle(double w, double h) {
        width = w;
        height = h;
    }

    double area() override {
        return width * height;
    }

    void print() override {
        cout << "I am a rectangle\n";
    }
};
```



---

# Essential Operations:
If you are defining custom types, like classes, you need to build constructors, destructors, copy, and move operations. 

Objects are copied/moved:
- Source of an assignment
- Object Initializer
- Function argument
- Function return value
- As an exception

---
Program with Multiple Code Files

You generally want to split up the work aacros multiple files. The compliler works across every file individually, not konwing about the contentso f other code files, or anything it's previosuly seen. 

A way of dealing with the compiler missing a function, is by providing it with a foward declaration:

```cpp
#include <iostream>
int add(int x, int y);
int main()
{
    std::cout << add(3,4);
    return 0;
}
```
what this did is that it allowed the compiler to see and identify what "add" is, recognize that it is a real function, and then when the function is executed in the main function, it'll connect the function compiled in add, and then insert it inot the main function to be executed. Give files access to functions living in other files. 

---
Header files:

Now as your files get bigger and bigger, it's bad process if you just keep spamming more and more forward declarations. This is where you star to tu se HEADER FILES. What this does its generally propogate all these related forward declarations all into one file. 

When you include a #include header, what it does is copy the contents of the header file into the curent file at that point. 